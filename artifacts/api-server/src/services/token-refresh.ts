import { db, socialAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptToken, encryptToken } from "./token-encryption";
import { logger } from "../lib/logger";
import type {
  TwitterTokenResponse,
  LinkedInTokenResponse,
  FacebookTokenResponse,
  TikTokTokenResponse,
  GoogleTokenResponse,
} from "../types/oauth";
import { getSocialCredential } from "./social-credentials";

export async function refreshExpiringTokens(): Promise<void> {
  try {
    const accounts = await db.select().from(socialAccountsTable);

    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    for (const account of accounts) {
      if (account.status === "revoked") continue;
      if (!account.tokenExpiry) continue;

      const timeUntilExpiry = account.tokenExpiry.getTime() - now;
      if (timeUntilExpiry > twentyFourHours) continue;

      logger.info(
        { platform: account.platform, accountName: account.accountName, expiresIn: Math.round(timeUntilExpiry / 1000 / 60) + " minutes" },
        "Attempting to refresh expiring token"
      );

      try {
        if (account.platform === "twitter" && account.refreshToken) {
          await refreshTwitterToken(account);
        } else if (account.platform === "linkedin" && account.refreshToken) {
          await refreshLinkedInToken(account);
        } else if (account.platform === "tiktok" && account.refreshToken) {
          await refreshTikTokToken(account);
        } else if (account.platform === "youtube" && account.refreshToken) {
          await refreshYouTubeToken(account);
        } else if (account.platform === "instagram") {
          await refreshInstagramToken(account);
        } else {
          if (timeUntilExpiry <= 0) {
            await db
              .update(socialAccountsTable)
              .set({ status: "expired", updatedAt: new Date() })
              .where(eq(socialAccountsTable.id, account.id));
          }
        }
      } catch (err) {
        logger.error({ err, platform: account.platform, accountId: account.id }, "Failed to refresh token");
        if (timeUntilExpiry <= 0) {
          await db
            .update(socialAccountsTable)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(socialAccountsTable.id, account.id));
        }
      }
    }
  } catch (err) {
    logger.error(err, "Token refresh check failed");
  }
}

type SocialAccountRecord = typeof socialAccountsTable.$inferSelect;

async function refreshTwitterToken(account: SocialAccountRecord): Promise<void> {
  const refreshTokenDecrypted = decryptToken(account.refreshToken!);
  const clientId = getSocialCredential("twitter", "clientId");
  if (!clientId) {
    throw new Error("Twitter refresh skipped: X/Twitter API Key not configured");
  }

  const response = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenDecrypted,
      client_id: clientId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Twitter refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as TwitterTokenResponse;
  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

  await db
    .update(socialAccountsTable)
    .set({
      accessToken: encryptToken(data.access_token),
      refreshToken: data.refresh_token ? encryptToken(data.refresh_token) : account.refreshToken,
      tokenExpiry: expiresAt,
      status: "connected",
      updatedAt: new Date(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "twitter", accountName: account.accountName }, "Token refreshed successfully");
}

async function refreshLinkedInToken(account: SocialAccountRecord): Promise<void> {
  const refreshTokenDecrypted = decryptToken(account.refreshToken!);
  const clientId = getSocialCredential("linkedin", "clientId");
  const clientSecret = getSocialCredential("linkedin", "clientSecret");
  if (!clientId || !clientSecret) {
    throw new Error("LinkedIn refresh skipped: LinkedIn Client ID/Secret not configured");
  }

  const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenDecrypted,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`LinkedIn refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as LinkedInTokenResponse;
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000)
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

  await db
    .update(socialAccountsTable)
    .set({
      accessToken: encryptToken(data.access_token),
      refreshToken: data.refresh_token ? encryptToken(data.refresh_token) : account.refreshToken,
      tokenExpiry: expiresAt,
      status: "connected",
      updatedAt: new Date(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "linkedin", accountName: account.accountName }, "Token refreshed successfully");
}

async function refreshTikTokToken(account: SocialAccountRecord): Promise<void> {
  const refreshTokenDecrypted = decryptToken(account.refreshToken!);
  const clientKey = getSocialCredential("tiktok", "clientId");
  const clientSecret = getSocialCredential("tiktok", "clientSecret");
  if (!clientKey || !clientSecret) {
    throw new Error("TikTok refresh skipped: TikTok Client Key/Secret not configured");
  }

  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshTokenDecrypted,
    }),
  });

  if (!response.ok) {
    throw new Error(`TikTok refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as TikTokTokenResponse;
  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

  await db
    .update(socialAccountsTable)
    .set({
      accessToken: encryptToken(data.access_token),
      refreshToken: data.refresh_token ? encryptToken(data.refresh_token) : account.refreshToken,
      tokenExpiry: expiresAt,
      status: "connected",
      updatedAt: new Date(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "tiktok", accountName: account.accountName }, "Token refreshed successfully");
}

async function refreshYouTubeToken(account: SocialAccountRecord): Promise<void> {
  const refreshTokenDecrypted = decryptToken(account.refreshToken!);
  const clientId = getSocialCredential("youtube", "clientId");
  const clientSecret = getSocialCredential("youtube", "clientSecret");
  if (!clientId || !clientSecret) {
    throw new Error("YouTube refresh skipped: Google Client ID/Secret not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenDecrypted,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`YouTube refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as GoogleTokenResponse;
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000)
    : new Date(Date.now() + 3600 * 1000);

  await db
    .update(socialAccountsTable)
    .set({
      accessToken: encryptToken(data.access_token),
      refreshToken: data.refresh_token ? encryptToken(data.refresh_token) : account.refreshToken,
      tokenExpiry: expiresAt,
      status: "connected",
      updatedAt: new Date(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "youtube", accountName: account.accountName }, "Token refreshed successfully");
}

async function refreshInstagramToken(account: SocialAccountRecord): Promise<void> {
  const accessTokenDecrypted = decryptToken(account.accessToken);
  const appId = getSocialCredential("instagram", "clientId");
  const appSecret = getSocialCredential("instagram", "clientSecret");
  if (!appId || !appSecret) {
    throw new Error("Instagram refresh skipped: Instagram App ID/Secret not configured");
  }

  const refreshUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
  refreshUrl.searchParams.set("grant_type", "fb_exchange_token");
  refreshUrl.searchParams.set("client_id", appId);
  refreshUrl.searchParams.set("client_secret", appSecret);
  refreshUrl.searchParams.set("fb_exchange_token", accessTokenDecrypted);

  const response = await fetch(refreshUrl.toString());

  if (!response.ok) {
    throw new Error(`Instagram refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as FacebookTokenResponse;
  const expiresIn = data.expires_in || 5184000;

  await db
    .update(socialAccountsTable)
    .set({
      accessToken: encryptToken(data.access_token),
      tokenExpiry: new Date(Date.now() + expiresIn * 1000),
      status: "connected",
      updatedAt: new Date(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "instagram", accountName: account.accountName }, "Token refreshed successfully");
}
