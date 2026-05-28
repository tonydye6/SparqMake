import { Router } from "express";
import { db, socialAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptToken, encryptToken } from "../services/token-encryption";
import { logger } from "../lib/logger";
import { requireRole } from "../middleware/auth";

async function isDefinitiveTokenFailure(resp: Response): Promise<boolean> {
  if (resp.status >= 400 && resp.status < 500) {
    try {
      const body = await resp.clone().text();
      const lower = body.toLowerCase();
      return lower.includes("invalid_grant") || lower.includes("invalid_token") || lower.includes("revoked");
    } catch {
      return resp.status === 400 || resp.status === 401;
    }
  }
  return false;
}
import type {
  TwitterTokenResponse,
  LinkedInTokenResponse,
  FacebookTokenResponse,
  TikTokTokenResponse,
  GoogleTokenResponse,
} from "../types/oauth";
import { TIKTOK_ENV_VARS } from "../constants";

const router = Router();

router.get("/social-accounts", async (_req, res) => {
  try {
    const accounts = await db.select({
      id: socialAccountsTable.id,
      platform: socialAccountsTable.platform,
      accountName: socialAccountsTable.accountName,
      accountId: socialAccountsTable.accountId,
      tokenExpiry: socialAccountsTable.tokenExpiry,
      profileImageUrl: socialAccountsTable.profileImageUrl,
      avatarUrl: socialAccountsTable.avatarUrl,
      platformMetadata: socialAccountsTable.platformMetadata,
      brandId: socialAccountsTable.brandId,
      status: socialAccountsTable.status,
      createdAt: socialAccountsTable.createdAt,
      updatedAt: socialAccountsTable.updatedAt,
    }).from(socialAccountsTable);

    const enriched = accounts.map(account => {
      let displayStatus = account.status;
      if (account.status === "connected" && account.tokenExpiry) {
        const hoursUntilExpiry = (account.tokenExpiry.getTime() - Date.now()) / (1000 * 60 * 60);
        if (hoursUntilExpiry <= 0) {
          displayStatus = "expired";
        } else if (hoursUntilExpiry <= 72) {
          displayStatus = "expiring";
        }
      }
      return { ...account, displayStatus };
    });

    res.json(enriched);
  } catch (err) {
    logger.error(err, "Failed to fetch social accounts");
    res.status(500).json({ error: "Failed to fetch social accounts" });
  }
});

router.get("/social-accounts/platform/:platform", async (req, res) => {
  try {
    const { platform } = req.params;

    const accounts = await db.select({
      id: socialAccountsTable.id,
      platform: socialAccountsTable.platform,
      accountName: socialAccountsTable.accountName,
      accountId: socialAccountsTable.accountId,
      brandId: socialAccountsTable.brandId,
      status: socialAccountsTable.status,
      createdAt: socialAccountsTable.createdAt,
    }).from(socialAccountsTable)
      .where(eq(socialAccountsTable.platform, platform));

    res.json(accounts);
  } catch (err) {
    logger.error(err, "Failed to fetch social accounts by platform");
    res.status(500).json({ error: "Failed to fetch social accounts" });
  }
});

router.delete("/social-accounts/:id", requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await db
      .delete(socialAccountsTable)
      .where(eq(socialAccountsTable.id, id))
      .returning();

    if (deleted.length === 0) {
      return res.status(404).json({ error: "Social account not found" });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error(err, "Failed to delete social account");
    res.status(500).json({ error: "Failed to delete social account" });
  }
});

router.post("/social-accounts/:id/refresh", requireRole("editor"), async (req, res) => {
  try {
    const { id } = req.params;

    const accounts = await db
      .select()
      .from(socialAccountsTable)
      .where(eq(socialAccountsTable.id, id));

    if (accounts.length === 0) {
      return res.status(404).json({ error: "Social account not found" });
    }

    const account = accounts[0];

    if (account.platform === "twitter" && account.refreshToken) {
      const refreshTokenDecrypted = decryptToken(account.refreshToken);
      const clientId = process.env.X_SparqMake_X_API_Key;

      const tokenResponse = await fetch("https://api.twitter.com/2/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshTokenDecrypted,
          client_id: clientId!,
        }),
      });

      if (!tokenResponse.ok) {
        if (await isDefinitiveTokenFailure(tokenResponse as unknown as Response)) {
          await db
            .update(socialAccountsTable)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(socialAccountsTable.id, id));
        } else {
          logger.warn({ id, status: tokenResponse.status }, "Transient token refresh failure; not marking expired");
        }
        return res.status(400).json({ error: "Token refresh failed" });
      }

      const tokenData: TwitterTokenResponse = await tokenResponse.json();
      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null;

      await db
        .update(socialAccountsTable)
        .set({
          accessToken: encryptToken(tokenData.access_token),
          refreshToken: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : account.refreshToken,
          tokenExpiry: expiresAt,
          status: "connected",
          updatedAt: new Date(),
        })
        .where(eq(socialAccountsTable.id, id));

      return res.json({ success: true, message: "Twitter token refreshed" });
    }

    if (account.platform === "linkedin" && account.refreshToken) {
      const refreshTokenDecrypted = decryptToken(account.refreshToken);
      const clientId = process.env.SparqMake_LinkedIn_Client_ID;
      const clientSecret = process.env.SparqMake_LinkedIn_Client_Secret;

      const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshTokenDecrypted,
          client_id: clientId!,
          client_secret: clientSecret!,
        }),
      });

      if (!tokenResponse.ok) {
        if (await isDefinitiveTokenFailure(tokenResponse as unknown as Response)) {
          await db
            .update(socialAccountsTable)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(socialAccountsTable.id, id));
        } else {
          logger.warn({ id, status: tokenResponse.status }, "Transient token refresh failure; not marking expired");
        }
        return res.status(400).json({ error: "Token refresh failed" });
      }

      const tokenData: LinkedInTokenResponse = await tokenResponse.json();
      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

      await db
        .update(socialAccountsTable)
        .set({
          accessToken: encryptToken(tokenData.access_token),
          refreshToken: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : account.refreshToken,
          tokenExpiry: expiresAt,
          status: "connected",
          updatedAt: new Date(),
        })
        .where(eq(socialAccountsTable.id, id));

      return res.json({ success: true, message: "LinkedIn token refreshed" });
    }

    if (account.platform === "youtube" && account.refreshToken) {
      const refreshTokenDecrypted = decryptToken(account.refreshToken);
      const clientId = process.env.SparqForge_Google_Client_ID;
      const clientSecret = process.env.SparqForge_Google_Client_Secret;

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshTokenDecrypted,
          client_id: clientId!,
          client_secret: clientSecret!,
        }),
      });

      if (!tokenResponse.ok) {
        if (await isDefinitiveTokenFailure(tokenResponse as unknown as Response)) {
          await db
            .update(socialAccountsTable)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(socialAccountsTable.id, id));
        } else {
          logger.warn({ id, status: tokenResponse.status }, "Transient token refresh failure; not marking expired");
        }
        return res.status(400).json({ error: "Token refresh failed" });
      }

      const tokenData: GoogleTokenResponse = await tokenResponse.json();
      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : new Date(Date.now() + 3600 * 1000);

      await db
        .update(socialAccountsTable)
        .set({
          accessToken: encryptToken(tokenData.access_token),
          refreshToken: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : account.refreshToken,
          tokenExpiry: expiresAt,
          status: "connected",
          updatedAt: new Date(),
        })
        .where(eq(socialAccountsTable.id, id));

      return res.json({ success: true, message: "YouTube token refreshed" });
    }

    if (account.platform === "instagram") {
      const accessTokenDecrypted = decryptToken(account.accessToken);
      const appId = process.env.SparqMake_Instagram_App_ID;
      const appSecret = process.env.SparqMake_Instagram_App_Secret;

      const refreshUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
      refreshUrl.searchParams.set("grant_type", "fb_exchange_token");
      refreshUrl.searchParams.set("client_id", appId!);
      refreshUrl.searchParams.set("client_secret", appSecret!);
      refreshUrl.searchParams.set("fb_exchange_token", accessTokenDecrypted);

      const tokenResponse = await fetch(refreshUrl.toString());

      if (!tokenResponse.ok) {
        if (await isDefinitiveTokenFailure(tokenResponse as unknown as Response)) {
          await db
            .update(socialAccountsTable)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(socialAccountsTable.id, id));
        } else {
          logger.warn({ id, status: tokenResponse.status }, "Transient token refresh failure; not marking expired");
        }
        return res.status(400).json({ error: "Token refresh failed" });
      }

      const tokenData: FacebookTokenResponse = await tokenResponse.json();
      const expiresIn = tokenData.expires_in || 5184000;

      await db
        .update(socialAccountsTable)
        .set({
          accessToken: encryptToken(tokenData.access_token),
          tokenExpiry: new Date(Date.now() + expiresIn * 1000),
          status: "connected",
          updatedAt: new Date(),
        })
        .where(eq(socialAccountsTable.id, id));

      return res.json({ success: true, message: "Instagram token refreshed" });
    }

    if (account.platform === "tiktok" && account.refreshToken) {
      const refreshTokenDecrypted = decryptToken(account.refreshToken);
      const clientKey = process.env[TIKTOK_ENV_VARS.clientId];
      const clientSecret = process.env[TIKTOK_ENV_VARS.clientSecret];

      const tokenResponse = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: clientKey!,
          client_secret: clientSecret!,
          grant_type: "refresh_token",
          refresh_token: refreshTokenDecrypted,
        }),
      });

      if (!tokenResponse.ok) {
        if (await isDefinitiveTokenFailure(tokenResponse as unknown as Response)) {
          await db
            .update(socialAccountsTable)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(socialAccountsTable.id, id));
        } else {
          logger.warn({ id, status: tokenResponse.status }, "Transient token refresh failure; not marking expired");
        }
        return res.status(400).json({ error: "Token refresh failed" });
      }

      const tokenData: TikTokTokenResponse = await tokenResponse.json();
      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null;

      await db
        .update(socialAccountsTable)
        .set({
          accessToken: encryptToken(tokenData.access_token),
          refreshToken: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : account.refreshToken,
          tokenExpiry: expiresAt,
          status: "connected",
          updatedAt: new Date(),
        })
        .where(eq(socialAccountsTable.id, id));

      return res.json({ success: true, message: "TikTok token refreshed" });
    }

    res.status(400).json({ error: "No refresh mechanism available for this platform" });
  } catch (err) {
    logger.error(err, "Failed to refresh token");
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

export default router;
