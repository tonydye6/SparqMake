import { logger } from "../lib/logger";
import { resolveUrl, readBuffer } from "./storage.js";

interface PublishTikTokOptions {
  accessToken: string;
  caption: string;
  imagePath?: string;
  videoPath?: string;
  postType?: "video" | "photo";
}

interface PublishResult {
  success: boolean;
  platformPostId?: string;
  error?: string;
  httpStatus?: number;
}

interface TikTokPublishInitResponse {
  data?: {
    publish_id?: string;
    upload_url?: string;
  };
  error?: {
    code: string;
    message: string;
    log_id?: string;
  };
}

interface TikTokPublishStatusResponse {
  data?: {
    status?: string;
    publicaly_available_post_id?: string[];
  };
  error?: {
    code: string;
    message: string;
    log_id?: string;
  };
}

async function initVideoUpload(
  accessToken: string,
  fileSize: number,
  caption: string,
): Promise<{ publishId: string; uploadUrl: string } | { error: string; httpStatus?: number }> {
  const resp = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_info: {
        title: caption,
        privacy_level: "SELF_ONLY",
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: fileSize,
        chunk_size: fileSize,
        total_chunk_count: 1,
      },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    logger.error({ status: resp.status, body: errBody }, "TikTok video init failed");
    return { error: `TikTok video init failed (${resp.status}): ${errBody}`, httpStatus: resp.status };
  }

  const data = (await resp.json()) as TikTokPublishInitResponse;

  if (data.error && data.error.code !== "ok") {
    return { error: `TikTok API error: ${data.error.message}`, httpStatus: resp.status };
  }

  if (!data.data?.publish_id || !data.data?.upload_url) {
    return { error: "TikTok init response missing publish_id or upload_url" };
  }

  return { publishId: data.data.publish_id, uploadUrl: data.data.upload_url };
}

async function uploadVideoChunk(uploadUrl: string, fileBuffer: Buffer): Promise<{ error?: string; httpStatus?: number }> {
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes 0-${fileBuffer.length - 1}/${fileBuffer.length}`,
      "Content-Length": String(fileBuffer.length),
    },
    body: fileBuffer,
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    logger.error({ status: resp.status, body: errBody }, "TikTok video chunk upload failed");
    return { error: `TikTok upload failed (${resp.status}): ${errBody}`, httpStatus: resp.status };
  }

  return {};
}

async function initPhotoPost(
  accessToken: string,
  caption: string,
  imageUrls: string[],
): Promise<{ publishId: string } | { error: string; httpStatus?: number }> {
  const resp = await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_info: {
        title: caption,
        privacy_level: "SELF_ONLY",
        disable_comment: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_cover_index: 0,
        photo_images: imageUrls,
      },
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    logger.error({ status: resp.status, body: errBody }, "TikTok photo init failed");
    return { error: `TikTok photo init failed (${resp.status}): ${errBody}`, httpStatus: resp.status };
  }

  const data = (await resp.json()) as TikTokPublishInitResponse;

  if (data.error && data.error.code !== "ok") {
    return { error: `TikTok API error: ${data.error.message}`, httpStatus: resp.status };
  }

  return { publishId: data.data?.publish_id || "" };
}

async function checkPublishStatus(
  accessToken: string,
  publishId: string,
): Promise<{ status: string; postId?: string; error?: string }> {
  const resp = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id: publishId }),
  });

  if (!resp.ok) {
    return { status: "FAILED", error: `Status check failed (${resp.status})` };
  }

  const data = (await resp.json()) as TikTokPublishStatusResponse;

  if (data.error && data.error.code !== "ok") {
    return { status: "FAILED", error: data.error.message };
  }

  const postIds = data.data?.publicaly_available_post_id;
  return {
    status: data.data?.status || "UNKNOWN",
    postId: postIds && postIds.length > 0 ? postIds[0] : undefined,
  };
}

export async function publishToTikTok(options: PublishTikTokOptions): Promise<PublishResult> {
  const { accessToken, caption, imagePath, videoPath, postType } = options;

  try {
    const mediaPath = videoPath || imagePath;
    const isVideo = postType === "video" || (videoPath && !imagePath) ||
      (mediaPath && /\.(mp4|mov|avi|webm)$/i.test(mediaPath));

    if (!mediaPath) {
      return { success: false, error: "TikTok requires a media file (video or image)", httpStatus: 400 };
    }

    const filename = mediaPath.split("/").pop() || mediaPath;
    const loc = resolveUrl(`/api/files/generated/${filename}`);
    if (!loc) {
      return { success: false, error: `Invalid media path: ${mediaPath}`, httpStatus: 400 };
    }

    if (isVideo) {
      const fileBuffer = await readBuffer(loc);
      if (!fileBuffer) {
        logger.warn({ mediaPath }, "Media file not found for TikTok upload");
        return { success: false, error: `Media file not found: ${mediaPath}`, httpStatus: 400 };
      }
      const initResult = await initVideoUpload(accessToken, fileBuffer.length, caption);

      if ("error" in initResult) {
        return { success: false, error: initResult.error, httpStatus: initResult.httpStatus };
      }

      const uploadResult = await uploadVideoChunk(initResult.uploadUrl, fileBuffer);
      if (uploadResult.error) {
        return { success: false, error: uploadResult.error, httpStatus: uploadResult.httpStatus };
      }

      logger.info({ publishId: initResult.publishId }, "TikTok video uploaded, awaiting processing");

      let attempts = 0;
      const maxAttempts = 30;
      const pollInterval = 10000;

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        const statusResult = await checkPublishStatus(accessToken, initResult.publishId);

        if (statusResult.status === "PUBLISH_COMPLETE") {
          logger.info({ publishId: initResult.publishId, postId: statusResult.postId }, "TikTok video published successfully");
          return { success: true, platformPostId: statusResult.postId || initResult.publishId };
        }

        if (statusResult.status === "FAILED") {
          return { success: false, error: `TikTok publish failed: ${statusResult.error || "Unknown error"}` };
        }

        attempts++;
      }

      logger.warn({ publishId: initResult.publishId }, "TikTok video publish status unknown after polling timeout");
      return { success: false, error: "TikTok publish timed out waiting for confirmation", httpStatus: 504 };
    } else {
      const photoBuffer = await readBuffer(loc);
      if (!photoBuffer) {
        logger.warn({ mediaPath }, "Media file not found for TikTok upload");
        return { success: false, error: `Media file not found: ${mediaPath}`, httpStatus: 400 };
      }

      const appUrl = process.env.APP_URL;
      const devDomain = process.env.REPLIT_DEV_DOMAIN;
      const domains = process.env.REPLIT_DOMAINS;
      let publicUrl: string;

      const apiFilePath = `/api/files/generated/${filename}`;

      if (appUrl) {
        publicUrl = `${appUrl.replace(/\/$/, "")}${apiFilePath}`;
      } else if (devDomain) {
        publicUrl = `https://${devDomain}${apiFilePath}`;
      } else if (domains) {
        const firstDomain = domains.split(",")[0].trim();
        publicUrl = `https://${firstDomain}${apiFilePath}`;
      } else {
        return { success: false, error: "Cannot determine public URL for photo upload", httpStatus: 500 };
      }

      const initResult = await initPhotoPost(accessToken, caption, [publicUrl]);

      if ("error" in initResult) {
        return { success: false, error: initResult.error, httpStatus: initResult.httpStatus };
      }

      if (!initResult.publishId) {
        return { success: false, error: "TikTok photo post init returned empty publish_id", httpStatus: 502 };
      }

      logger.info({ publishId: initResult.publishId }, "TikTok photo post published");
      return { success: true, platformPostId: initResult.publishId };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "TikTok publish error");
    return { success: false, error: message };
  }
}
