import OAuth from "oauth-1.0a";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { resolveUrl, readBuffer } from "./storage.js";

interface PublishTwitterOptions {
  accessToken: string;
  text: string;
  imageUrl?: string;
  imagePath?: string;
}

interface PublishResult {
  success: boolean;
  platformPostId?: string;
  error?: string;
  httpStatus?: number;
}

// OAuth 1.0a credentials for Twitter media upload (v1.1 API).
// Twitter's media upload endpoint requires OAuth 1.0a, even when tweet creation uses OAuth 2.0 Bearer tokens.
//
// Required environment variables:
//   X_SparqMake_X_API_Key          – Twitter app's Consumer Key (API Key), from the Twitter Developer Portal → App → Keys and Tokens
//   X_SparqMake_X_API_Secret       – Twitter app's Consumer Secret (API Secret), same section
//   X_SparqMake_X_Access_Token     – User-level OAuth 1.0a Access Token, generated under "Authentication Tokens" in the Developer Portal
//   X_SparqMake_X_Access_Token_Secret – Corresponding Access Token Secret
//
// These credentials must belong to the same Twitter account whose OAuth 2.0 Bearer token is used for tweet creation,
// so that uploaded media can be attached to tweets authored by that account.
function getOAuth1Credentials() {
  const consumerKey = process.env.X_SparqMake_X_API_Key;
  const consumerSecret = process.env.X_SparqMake_X_API_Secret;
  const oauthToken = process.env.X_SparqMake_X_Access_Token;
  const oauthTokenSecret = process.env.X_SparqMake_X_Access_Token_Secret;

  if (!consumerKey || !consumerSecret || !oauthToken || !oauthTokenSecret) {
    return null;
  }

  return { consumerKey, consumerSecret, oauthToken, oauthTokenSecret };
}

function createOAuth1Header(
  url: string,
  method: string,
  creds: NonNullable<ReturnType<typeof getOAuth1Credentials>>,
  data?: Record<string, string>,
): string {
  const oauth = new OAuth({
    consumer: { key: creds.consumerKey, secret: creds.consumerSecret },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });

  const token = { key: creds.oauthToken, secret: creds.oauthTokenSecret };
  const authHeader = oauth.toHeader(oauth.authorize({ url, method, data }, token));
  return authHeader.Authorization;
}

async function uploadMedia(accessToken: string, imagePath: string): Promise<string | null> {
  try {
    const filename = imagePath.split("/").pop() || imagePath;
    const loc = resolveUrl(`/api/files/generated/${filename}`);
    if (!loc) {
      logger.warn({ imagePath }, "Invalid image path for Twitter upload");
      return null;
    }

    const imageBuffer = await readBuffer(loc);
    if (!imageBuffer) {
      logger.warn({ imagePath }, "Image file not found for Twitter upload");
      return null;
    }

    const base64 = imageBuffer.toString("base64");
    const mimeType = filename.endsWith(".png") ? "image/png" : "image/jpeg";

    const oauth1Creds = getOAuth1Credentials();
    if (!oauth1Creds) {
      logger.error("Twitter media upload requires OAuth 1.0a credentials. Set env vars: X_SparqMake_X_API_Key, X_SparqMake_X_API_Secret, X_SparqMake_X_Access_Token, X_SparqMake_X_Access_Token_Secret. These must belong to the same account whose OAuth2 Bearer token is used for tweet creation.");
      return null;
    }
    logger.info("Using OAuth 1.0a for Twitter media upload. Ensure the OAuth 1.0a access token belongs to the same account as the OAuth2 Bearer token used for tweet creation.");

    const mediaUploadUrl = "https://upload.twitter.com/1.1/media/upload.json";

    const initData_params: Record<string, string> = {
      command: "INIT",
      total_bytes: String(imageBuffer.length),
      media_type: mimeType,
    };

    const initResp = await fetch(mediaUploadUrl, {
      method: "POST",
      headers: {
        Authorization: createOAuth1Header(mediaUploadUrl, "POST", oauth1Creds, initData_params),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(initData_params),
    });

    if (!initResp.ok) {
      const err = await initResp.text();
      logger.error({ status: initResp.status, body: err }, "Twitter media INIT failed");
      return null;
    }

    const initData = await initResp.json() as { media_id_string: string };
    const mediaId = initData.media_id_string;

    const appendParams: Record<string, string> = {
      command: "APPEND",
      media_id: mediaId,
      segment_index: "0",
      media_data: base64,
    };

    const appendResp = await fetch(mediaUploadUrl, {
      method: "POST",
      headers: {
        Authorization: createOAuth1Header(mediaUploadUrl, "POST", oauth1Creds, appendParams),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(appendParams),
    });

    if (!appendResp.ok) {
      const err = await appendResp.text();
      logger.error({ status: appendResp.status, body: err }, "Twitter media APPEND failed");
      return null;
    }

    const finalizeParams: Record<string, string> = {
      command: "FINALIZE",
      media_id: mediaId,
    };

    const finalizeResp = await fetch(mediaUploadUrl, {
      method: "POST",
      headers: {
        Authorization: createOAuth1Header(mediaUploadUrl, "POST", oauth1Creds, finalizeParams),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(finalizeParams),
    });

    if (!finalizeResp.ok) {
      const err = await finalizeResp.text();
      logger.error({ status: finalizeResp.status, body: err }, "Twitter media FINALIZE failed");
      return null;
    }

    return mediaId;
  } catch (err) {
    logger.error({ err }, "Twitter media upload error");
    return null;
  }
}

export async function publishToTwitter(options: PublishTwitterOptions): Promise<PublishResult> {
  const { accessToken, text, imagePath } = options;

  try {
    let mediaIds: string[] = [];

    if (imagePath) {
      const mediaId = await uploadMedia(accessToken, imagePath);
      if (mediaId) {
        mediaIds = [mediaId];
      }
    }

    const tweetBody: Record<string, unknown> = { text };
    if (mediaIds.length > 0) {
      tweetBody.media = { media_ids: mediaIds };
    }

    const resp = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tweetBody),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      logger.error({ status: resp.status, body: errBody }, "Twitter tweet creation failed");
      return { success: false, error: `Twitter API error (${resp.status}): ${errBody}`, httpStatus: resp.status };
    }

    const data = await resp.json() as { data: { id: string } };
    logger.info({ tweetId: data.data.id }, "Tweet published successfully");
    return { success: true, platformPostId: data.data.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "Twitter publish error");
    return { success: false, error: message };
  }
}
