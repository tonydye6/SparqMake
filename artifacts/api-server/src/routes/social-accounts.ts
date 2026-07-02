import { str } from "../lib/http-params.js";
import { Router } from "express";
import { db, socialAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { requireStandardWrite, requireDestructive } from "../middleware/auth";
import { recordAudit, actorFromRequest } from "../lib/audit";
import {
  refreshAccountToken,
  recordRefreshFailure,
  TokenRefreshError,
} from "../services/token-refresh";
import { getPlatformConfigStatus } from "../services/social-credentials";

const router = Router();

router.get("/social-platforms/status", (_req, res) => {
  res.json({ platforms: getPlatformConfigStatus() });
});

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
      lastRefreshAt: socialAccountsTable.lastRefreshAt,
      lastRefreshError: socialAccountsTable.lastRefreshError,
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
    const platform = str(req.params.platform);

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

router.delete("/social-accounts/:id", requireDestructive, async (req, res) => {
  try {
    const id = str(req.params.id);

    const deleted = await db
      .delete(socialAccountsTable)
      .where(eq(socialAccountsTable.id, id))
      .returning();

    if (deleted.length === 0) {
      res.status(404).json({ error: "Social account not found" });
      return;
    }

    const account = deleted[0];
    await recordAudit({
      actor: actorFromRequest(req),
      action: "social_account.delete",
      entityType: "social_account",
      entityIds: [account.id],
      brandId: account.brandId,
      metadata: { platform: account.platform, accountName: account.accountName },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(err, "Failed to delete social account");
    res.status(500).json({ error: "Failed to delete social account" });
  }
});

const PLATFORM_LABELS: Record<string, string> = {
  twitter: "Twitter",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
};

router.post("/social-accounts/:id/refresh", requireStandardWrite, async (req, res) => {
  try {
    const id = str(req.params.id);

    const accounts = await db
      .select()
      .from(socialAccountsTable)
      .where(eq(socialAccountsTable.id, id));

    if (accounts.length === 0) {
      res.status(404).json({ error: "Social account not found" });
      return;
    }

    const account = accounts[0];

    try {
      await refreshAccountToken(account);
    } catch (err) {
      if (err instanceof TokenRefreshError && err.message.includes("No refresh mechanism")) {
        res.status(400).json({ error: "No refresh mechanism available for this platform" });
        return;
      }
      if (err instanceof TokenRefreshError && err.message.includes("not configured")) {
        res.status(400).json({ error: err.message.replace(/^.*skipped: /, "") });
        return;
      }
      logger.warn({ err, id }, "Manual token refresh failed");
      try {
        await recordRefreshFailure(account, err);
      } catch (recordErr) {
        logger.error({ err: recordErr, id }, "Failed to record refresh failure");
      }
      const needsReconnect = err instanceof TokenRefreshError && err.definitive;
      res.status(400).json({
        error: needsReconnect
          ? "The platform rejected this connection — please reconnect the account"
          : "Token refresh failed",
      });
      return;
    }

    const label = PLATFORM_LABELS[account.platform] || account.platform;
    res.json({ success: true, message: `${label} token refreshed` });
  } catch (err) {
    logger.error(err, "Failed to refresh token");
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

export default router;
