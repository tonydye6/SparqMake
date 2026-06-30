import { logger } from "../lib/logger";
import { resolveUrl, readBuffer } from "./storage.js";

interface PublishYouTubeOptions {
  accessToken: string;
  title: string;
  description: string;
  tags?: string[];
  videoPath: string;
  publishAt?: Date;
}

interface PublishResult {
  success: boolean;
  platformPostId?: string;
  error?: string;
  httpStatus?: number;
}

function parseYouTubeError(status: number, body: string): { error: string; httpStatus: number } {
  let parsed: { error?: { errors?: Array<{ reason?: string; message?: string }> } } = {};
  try { parsed = JSON.parse(body); } catch {}

  const reason = parsed?.error?.errors?.[0]?.reason;
  const message = parsed?.error?.errors?.[0]?.message;

  if (status === 403 && (reason === "quotaExceeded" || reason === "dailyLimitExceeded")) {
    return {
      error: "YouTube API quota exceeded. Try again later.",
      httpStatus: 429,
    };
  }

  if (reason === "uploadLimitExceeded") {
    return {
      error: "YouTube upload limit exceeded. Try again later.",
      httpStatus: 429,
    };
  }

  if (reason === "videoAlreadyExists" || reason === "duplicateUpload") {
    return {
      error: `Duplicate video detected: ${message || "This video has already been uploaded to YouTube."}`,
      httpStatus: 409,
    };
  }

  return {
    error: `YouTube API error (${status}): ${message || body}`,
    httpStatus: status,
  };
}

export async function publishToYouTube(options: PublishYouTubeOptions): Promise<PublishResult> {
  const { accessToken, title, description, tags, videoPath, publishAt } = options;

  try {
    const filename = videoPath.split("/").pop() || videoPath;
    const loc = resolveUrl(`/api/files/generated/${filename}`);
    if (!loc) {
      return { success: false, error: "Invalid video path" };
    }

    const videoBuffer = await readBuffer(loc);
    if (!videoBuffer) {
      logger.error({ videoPath }, "Video file not found for YouTube upload");
      return { success: false, error: "Video file not found" };
    }

    const fileSize = videoBuffer.length;

    const dotIdx = filename.lastIndexOf(".");
    const ext = dotIdx >= 0 ? filename.slice(dotIdx).toLowerCase() : "";
    const mimeMap: Record<string, string> = {
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".wmv": "video/x-ms-wmv",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
    };
    const contentType = mimeMap[ext] || "video/mp4";

    const statusObj: Record<string, unknown> = {
      selfDeclaredMadeForKids: false,
    };

    if (publishAt && publishAt.getTime() > Date.now() + 60_000) {
      statusObj.privacyStatus = "private";
      statusObj.publishAt = publishAt.toISOString();
    } else {
      statusObj.privacyStatus = "public";
    }

    const metadata = {
      snippet: {
        title: title || "Untitled Video",
        description: description || "",
        tags: tags || [],
        categoryId: "20",
      },
      status: statusObj,
    };

    const initResponse = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(fileSize),
          "X-Upload-Content-Type": contentType,
        },
        body: JSON.stringify(metadata),
      },
    );

    if (!initResponse.ok) {
      const errBody = await initResponse.text();
      logger.error({ status: initResponse.status, body: errBody }, "YouTube upload init failed");
      return { success: false, ...parseYouTubeError(initResponse.status, errBody) };
    }

    const uploadUrl = initResponse.headers.get("location");
    if (!uploadUrl) {
      return { success: false, error: "YouTube did not return a resumable upload URL" };
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(fileSize),
        "Content-Type": contentType,
      },
      body: videoBuffer,
    });

    if (!uploadResponse.ok) {
      const errBody = await uploadResponse.text();
      logger.error({ status: uploadResponse.status, body: errBody }, "YouTube video upload failed");
      return { success: false, ...parseYouTubeError(uploadResponse.status, errBody) };
    }

    const uploadData = await uploadResponse.json() as {
      id: string;
      status?: { uploadStatus?: string; failureReason?: string; rejectionReason?: string };
    };

    if (uploadData.status?.uploadStatus === "failed") {
      const reason = uploadData.status.failureReason || uploadData.status.rejectionReason || "Unknown processing error";
      logger.error({ videoId: uploadData.id, reason }, "YouTube video processing failed");
      return {
        success: false,
        error: `YouTube processing error: ${reason}`,
        platformPostId: uploadData.id,
      };
    }

    logger.info({ videoId: uploadData.id }, "YouTube video published successfully");
    return { success: true, platformPostId: uploadData.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "YouTube publish error");
    return { success: false, error: message };
  }
}
