import { logger } from "../lib/logger";
import { resolveUrl, readBuffer } from "./storage.js";

const LINKEDIN_API_VERSION = "202401";

interface PublishLinkedInOptions {
  accessToken: string;
  authorUrn: string;
  text: string;
  imagePath?: string;
}

interface PublishResult {
  success: boolean;
  platformPostId?: string;
  error?: string;
  httpStatus?: number;
}

function ensurePersonUrn(accountId: string): string {
  if (accountId.startsWith("urn:li:person:")) {
    return accountId;
  }
  if (accountId.startsWith("urn:li:")) {
    return accountId;
  }
  return `urn:li:person:${accountId}`;
}

async function uploadImage(accessToken: string, authorUrn: string, imagePath: string): Promise<string | null> {
  try {
    const filename = imagePath.split("/").pop() || imagePath;
    const loc = resolveUrl(`/api/files/generated/${filename}`);
    if (!loc) {
      logger.warn({ imagePath }, "Invalid image path for LinkedIn upload");
      return null;
    }

    const imageBuffer = await readBuffer(loc);
    if (!imageBuffer) {
      logger.warn({ imagePath }, "Image file not found for LinkedIn upload");
      return null;
    }

    const initResp = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: authorUrn,
        },
      }),
    });

    if (!initResp.ok) {
      const err = await initResp.text();
      logger.error({ status: initResp.status, body: err }, "LinkedIn image upload init failed");
      return null;
    }

    const initData = await initResp.json() as {
      value: {
        uploadUrl: string;
        image: string;
      };
    };

    const uploadUrl = initData.value.uploadUrl;
    const imageUrn = initData.value.image;

    const uploadResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: imageBuffer,
    });

    if (!uploadResp.ok) {
      const err = await uploadResp.text();
      logger.error({ status: uploadResp.status, body: err }, "LinkedIn image upload failed");
      return null;
    }

    return imageUrn;
  } catch (err) {
    logger.error({ err }, "LinkedIn image upload error");
    return null;
  }
}

export async function publishToLinkedIn(options: PublishLinkedInOptions): Promise<PublishResult> {
  const { accessToken, text, imagePath } = options;
  const authorUrn = ensurePersonUrn(options.authorUrn);

  try {
    let imageUrn: string | null = null;

    if (imagePath) {
      imageUrn = await uploadImage(accessToken, authorUrn, imagePath);
    }

    const postBody: Record<string, unknown> = {
      author: authorUrn,
      commentary: text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
    };

    if (imageUrn) {
      postBody.content = {
        media: {
          title: "Post image",
          id: imageUrn,
        },
      };
    }

    const resp = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(postBody),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      logger.error({ status: resp.status, body: errBody }, "LinkedIn post creation failed");
      return { success: false, error: `LinkedIn API error (${resp.status}): ${errBody}`, httpStatus: resp.status };
    }

    const postId = resp.headers.get("x-restli-id") || resp.headers.get("x-linkedin-id") || "unknown";
    logger.info({ postId }, "LinkedIn post published successfully");
    return { success: true, platformPostId: postId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "LinkedIn publish error");
    return { success: false, error: message };
  }
}
