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

type SocialAccountRecord = typeof socialAccountsTable.$inferSelect;

/**
 * Thrown when a token refresh attempt fails. `definitive` means the platform
 * rejected the credentials themselves (revoked/invalid grant) — retrying will
 * never succeed and the account needs a full reconnect.
 */
export class TokenRefreshError extends Error {
  constructor(
    message: string,
    public readonly definitive: boolean,
  ) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

async function classifyFailure(response: globalThis.Response, platformLabel: string): Promise<TokenRefreshError> {
  let definitive = false;
  if (response.status >= 400 && response.status < 500) {
    try {
      const body = await response.clone().text();
      const lower = body.toLowerCase();
      definitive =
        lower.includes("invalid_grant") ||
        lower.includes("invalid_token") ||
        lower.includes("revoked");
    } catch {
      definitive = response.status === 400 || response.status === 401;
    }
  }
  return new TokenRefreshError(`${platformLabel} refresh failed: ${response.status}`, definitive);
}

function canRefresh(account: SocialAccountRecord): boolean {
  if (account.platform === "instagram") return true;
  return (
    Boolean(account.refreshToken) &&
    ["twitter", "linkedin", "tiktok", "youtube"].includes(account.platform)
  );
}

/**
 * Refresh a single account's token against the platform API and persist the
 * new credentials plus a healthy refresh record. Throws TokenRefreshError on
 * failure (does not persist failure state — callers own that decision).
 */
export async function refreshAccountToken(account: SocialAccountRecord): Promise<void> {
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
    throw new TokenRefreshError("No refresh mechanism available for this platform", false);
  }
}

/**
 * Persist a failed refresh attempt on the account. Definitive failures mark
 * the account as needing reconnection so it is not silently retried forever;
 * transient failures keep the current status unless the token is already past
 * expiry, in which case the account is marked expired.
 */
export async function recordRefreshFailure(
  account: SocialAccountRecord,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : "Token refresh failed";
  const definitive = err instanceof TokenRefreshError && err.definitive;
  const pastExpiry = account.tokenExpiry ? account.tokenExpiry.getTime() <= Date.now() : false;

  const nextStatus = definitive
    ? "needs_reconnect"
    : pastExpiry
      ? "expired"
      : account.status;

  await db
    .update(socialAccountsTable)
    .set({
      status: nextStatus,
      lastRefreshAt: new Date(),
      lastRefreshError: message,
      updatedAt: new Date(),
    })
    .where(eq(socialAccountsTable.id, account.id));
}

export async function refreshExpiringTokens(): Promise<void> {
  try {
    const accounts = await db.select().from(socialAccountsTable);

    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    for (const account of accounts) {
      if (account.status === "revoked") continue;
      // Definitive failures need a user-driven reconnect; retrying is pointless.
      if (account.status === "needs_reconnect") continue;
      if (!account.tokenExpiry) continue;

      const timeUntilExpiry = account.tokenExpiry.getTime() - now;
      if (timeUntilExpiry > twentyFourHours) continue;

      if (!canRefresh(account)) {
        if (timeUntilExpiry <= 0 && account.status !== "expired") {
          await db
            .update(socialAccountsTable)
            .set({
              status: "expired",
              lastRefreshAt: new Date(),
              lastRefreshError: "Token expired and this platform has no refresh mechanism",
              updatedAt: new Date(),
            })
            .where(eq(socialAccountsTable.id, account.id));
        }
        continue;
      }

      logger.info(
        { platform: account.platform, accountName: account.accountName, expiresIn: Math.round(timeUntilExpiry / 1000 / 60) + " minutes" },
        "Attempting to refresh expiring token"
      );

      try {
        await refreshAccountToken(account);
      } catch (err) {
        logger.error({ err, platform: account.platform, accountId: account.id }, "Failed to refresh token");
        try {
          await recordRefreshFailure(account, err);
        } catch (recordErr) {
          logger.error({ err: recordErr, accountId: account.id }, "Failed to record refresh failure");
        }
      }
    }
  } catch (err) {
    logger.error(err, "Token refresh check failed");
  }
}

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // hourly — tokens are refreshed within 24h of expiry

let refreshTimer: NodeJS.Timeout | null = null;
let cycleRunning = false;

async function runRefreshCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    await refreshExpiringTokens();
  } finally {
    cycleRunning = false;
  }
}

export function startTokenRefreshScheduler(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    runRefreshCycle().catch((err) => logger.error(err, "Token refresh cycle failed"));
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();

  runRefreshCycle()
    .then(() => logger.info("Initial token refresh check completed"))
    .catch((err) => logger.error(err, "Initial token refresh check failed"));

  logger.info({ intervalMinutes: REFRESH_INTERVAL_MS / 60000 }, "Token refresh scheduler started");
}

export function stopTokenRefreshScheduler(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function healthyRefreshFields() {
  return {
    status: "connected" as const,
    lastRefreshAt: new Date(),
    lastRefreshError: null,
    updatedAt: new Date(),
  };
}

async function refreshTwitterToken(account: SocialAccountRecord): Promise<void> {
  const refreshTokenDecrypted = decryptToken(account.refreshToken!);
  const clientId = getSocialCredential("twitter", "clientId");
  if (!clientId) {
    throw new TokenRefreshError("Twitter refresh skipped: X/Twitter API Key not configured", false);
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
    throw await classifyFailure(response, "Twitter");
  }

  const data = (await response.json()) as TwitterTokenResponse;
  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

  await db
    .update(socialAccountsTable)
    .set({
      accessToken: encryptToken(data.access_token),
      refreshToken: data.refresh_token ? encryptToken(data.refresh_token) : account.refreshToken,
      tokenExpiry: expiresAt,
      ...healthyRefreshFields(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "twitter", accountName: account.accountName }, "Token refreshed successfully");
}

async function refreshLinkedInToken(account: SocialAccountRecord): Promise<void> {
  const refreshTokenDecrypted = decryptToken(account.refreshToken!);
  const clientId = getSocialCredential("linkedin", "clientId");
  const clientSecret = getSocialCredential("linkedin", "clientSecret");
  if (!clientId || !clientSecret) {
    throw new TokenRefreshError("LinkedIn refresh skipped: LinkedIn Client ID/Secret not configured", false);
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
    throw await classifyFailure(response, "LinkedIn");
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
      ...healthyRefreshFields(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "linkedin", accountName: account.accountName }, "Token refreshed successfully");
}

async function refreshTikTokToken(account: SocialAccountRecord): Promise<void> {
  const refreshTokenDecrypted = decryptToken(account.refreshToken!);
  const clientKey = getSocialCredential("tiktok", "clientId");
  const clientSecret = getSocialCredential("tiktok", "clientSecret");
  if (!clientKey || !clientSecret) {
    throw new TokenRefreshError("TikTok refresh skipped: TikTok Client Key/Secret not configured", false);
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
    throw await classifyFailure(response, "TikTok");
  }

  const data = (await response.json()) as TikTokTokenResponse;
  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

  await db
    .update(socialAccountsTable)
    .set({
      accessToken: encryptToken(data.access_token),
      refreshToken: data.refresh_token ? encryptToken(data.refresh_token) : account.refreshToken,
      tokenExpiry: expiresAt,
      ...healthyRefreshFields(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "tiktok", accountName: account.accountName }, "Token refreshed successfully");
}

async function refreshYouTubeToken(account: SocialAccountRecord): Promise<void> {
  const refreshTokenDecrypted = decryptToken(account.refreshToken!);
  const clientId = getSocialCredential("youtube", "clientId");
  const clientSecret = getSocialCredential("youtube", "clientSecret");
  if (!clientId || !clientSecret) {
    throw new TokenRefreshError("YouTube refresh skipped: Google Client ID/Secret not configured", false);
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
    throw await classifyFailure(response, "YouTube");
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
      ...healthyRefreshFields(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "youtube", accountName: account.accountName }, "Token refreshed successfully");
}

async function refreshInstagramToken(account: SocialAccountRecord): Promise<void> {
  const accessTokenDecrypted = decryptToken(account.accessToken);
  const appId = getSocialCredential("instagram", "clientId");
  const appSecret = getSocialCredential("instagram", "clientSecret");
  if (!appId || !appSecret) {
    throw new TokenRefreshError("Instagram refresh skipped: Instagram App ID/Secret not configured", false);
  }

  const refreshUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
  refreshUrl.searchParams.set("grant_type", "fb_exchange_token");
  refreshUrl.searchParams.set("client_id", appId);
  refreshUrl.searchParams.set("client_secret", appSecret);
  refreshUrl.searchParams.set("fb_exchange_token", accessTokenDecrypted);

  const response = await fetch(refreshUrl.toString());

  if (!response.ok) {
    throw await classifyFailure(response, "Instagram");
  }

  const data = (await response.json()) as FacebookTokenResponse;
  const expiresIn = data.expires_in || 5184000;

  await db
    .update(socialAccountsTable)
    .set({
      accessToken: encryptToken(data.access_token),
      tokenExpiry: new Date(Date.now() + expiresIn * 1000),
      ...healthyRefreshFields(),
    })
    .where(eq(socialAccountsTable.id, account.id));

  logger.info({ platform: "instagram", accountName: account.accountName }, "Token refreshed successfully");
}
