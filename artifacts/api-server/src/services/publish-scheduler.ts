import { eq, and, lte, or } from "drizzle-orm";
import { db, calendarEntriesTable, creativeVariantsTable, creativesTable, socialAccountsTable } from "@workspace/db";
import { publishToTwitter } from "./publish-twitter";
import { publishToInstagram } from "./publish-instagram";
import { publishToLinkedIn } from "./publish-linkedin";
import { publishToTikTok } from "./publish-tiktok";
import { publishToYouTube } from "./publish-youtube";
import { decryptToken } from "./token-encryption";
import { logger } from "../lib/logger";

const POLL_INTERVAL_MS = 60_000;
const MAX_RETRIES = 3;

function isPermanentFailure(httpStatus: number | undefined): boolean {
  if (!httpStatus) return false;
  if (httpStatus === 429) return false;
  if (httpStatus >= 400 && httpStatus < 500) return true;
  return false;
}

function getBackoffMs(retryCount: number): number {
  return Math.min(60_000 * Math.pow(2, retryCount), 15 * 60_000);
}

function getPublicImageUrl(compositedImageUrl: string | null): string | null {
  if (!compositedImageUrl) return null;
  if (compositedImageUrl.startsWith("http://") || compositedImageUrl.startsWith("https://")) {
    return compositedImageUrl;
  }
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    return `${appUrl.replace(/\/$/, "")}${compositedImageUrl}`;
  }
  if (process.env.REPLIT_DEPLOYMENT) {
    const domains = process.env.REPLIT_DOMAINS;
    if (domains) {
      const firstDomain = domains.split(",")[0].trim();
      if (firstDomain) {
        return `https://${firstDomain}${compositedImageUrl}`;
      }
    }
  }
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) {
    return `https://${devDomain}${compositedImageUrl}`;
  }
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const firstDomain = domains.split(",")[0].trim();
    if (firstDomain) {
      return `https://${firstDomain}${compositedImageUrl}`;
    }
  }
  return null;
}

function getImageFilePath(compositedImageUrl: string | null): string | null {
  if (!compositedImageUrl) return null;
  const filename = compositedImageUrl.split("/").pop();
  if (!filename) return null;
  return `uploads/generated/${filename}`;
}

async function publishEntry(entryId: string): Promise<void> {
  const claimed = await db.transaction(async (tx) => {
    const [entry] = await tx.select().from(calendarEntriesTable).where(eq(calendarEntriesTable.id, entryId));
    if (!entry) {
      logger.warn({ entryId }, "Calendar entry not found for publishing");
      return null;
    }

    const [updated] = await tx.update(calendarEntriesTable)
      .set({ publishStatus: "publishing", updatedAt: new Date() })
      .where(and(
        eq(calendarEntriesTable.id, entryId),
        or(
          eq(calendarEntriesTable.publishStatus, "scheduled"),
          eq(calendarEntriesTable.publishStatus, "failed")
        )
      ))
      .returning();

    if (!updated) {
      logger.info({ entryId }, "Entry already being processed, skipping");
      return null;
    }

    if (!entry.socialAccountId) {
      await tx.update(calendarEntriesTable)
        .set({
          publishStatus: "failed",
          publishError: "No social account connected for this entry",
          retryCount: (entry.retryCount || 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(calendarEntriesTable.id, entryId));
      return null;
    }

    const [socialAccount] = await tx.select().from(socialAccountsTable)
      .where(eq(socialAccountsTable.id, entry.socialAccountId));

    if (!socialAccount) {
      await tx.update(calendarEntriesTable)
        .set({
          publishStatus: "failed",
          publishError: "Social account not found",
          retryCount: (entry.retryCount || 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(calendarEntriesTable.id, entryId));
      return null;
    }

    const platformMap: Record<string, string> = {
      twitter: "twitter",
      instagram_feed: "instagram",
      instagram_story: "instagram",
      linkedin: "linkedin",
      tiktok: "tiktok",
      youtube: "youtube",
    };
    const expectedPlatform = platformMap[entry.platform] || entry.platform;
    if (socialAccount.platform !== expectedPlatform && socialAccount.platform !== entry.platform) {
      await tx.update(calendarEntriesTable)
        .set({
          publishStatus: "failed",
          publishError: `Platform mismatch: entry is ${entry.platform} but account is ${socialAccount.platform}`,
          retryCount: (entry.retryCount || 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(calendarEntriesTable.id, entryId));
      return null;
    }

    const [variant] = await tx.select().from(creativeVariantsTable)
      .where(eq(creativeVariantsTable.id, entry.variantId));

    if (!variant) {
      await tx.update(calendarEntriesTable)
        .set({
          publishStatus: "failed",
          publishError: "Creative variant not found",
          retryCount: (entry.retryCount || 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(calendarEntriesTable.id, entryId));
      return null;
    }

    if (variant.creativeId !== entry.creativeId) {
      await tx.update(calendarEntriesTable)
        .set({
          publishStatus: "failed",
          publishError: "Variant does not belong to the entry's creative",
          retryCount: MAX_RETRIES,
          updatedAt: new Date(),
        })
        .where(eq(calendarEntriesTable.id, entryId));
      return null;
    }

    const [creative] = await tx.select({ id: creativesTable.id, brandId: creativesTable.brandId })
      .from(creativesTable).where(eq(creativesTable.id, entry.creativeId));
    if (!creative) {
      await tx.update(calendarEntriesTable)
        .set({
          publishStatus: "failed",
          publishError: "Parent creative not found",
          retryCount: MAX_RETRIES,
          updatedAt: new Date(),
        })
        .where(eq(calendarEntriesTable.id, entryId));
      return null;
    }

    if (socialAccount.brandId && socialAccount.brandId !== creative.brandId) {
      await tx.update(calendarEntriesTable)
        .set({
          publishStatus: "failed",
          publishError: `Brand mismatch: account belongs to brand ${socialAccount.brandId} but creative belongs to brand ${creative.brandId}`,
          retryCount: MAX_RETRIES,
          updatedAt: new Date(),
        })
        .where(eq(calendarEntriesTable.id, entryId));
      return null;
    }

    return { entry, socialAccount, variant };
  });

  if (!claimed) return;

  const { entry, socialAccount, variant } = claimed;
  const newRetryCount = (entry.retryCount || 0) + 1;
  const caption = variant.caption || "";
  const imagePath = getImageFilePath(variant.compositedImageUrl);
  const publicImageUrl = getPublicImageUrl(variant.compositedImageUrl);
  const videoPath = getImageFilePath(variant.mergedVideoUrl || variant.videoUrl);

  let result: { success: boolean; platformPostId?: string; error?: string; httpStatus?: number };

  const platform = entry.platform;
  let decryptedAccessToken: string;
  try {
    decryptedAccessToken = decryptToken(socialAccount.accessToken);
  } catch (err) {
    await db.update(calendarEntriesTable)
      .set({
        publishStatus: "failed",
        publishError: "Failed to decrypt access token",
        retryCount: newRetryCount,
        updatedAt: new Date(),
      })
      .where(and(
        eq(calendarEntriesTable.id, entryId),
        eq(calendarEntriesTable.publishStatus, "publishing")
      ));
    return;
  }

  try {
    if (platform === "twitter") {
      result = await publishToTwitter({
        accessToken: decryptedAccessToken,
        text: caption,
        imagePath: imagePath || undefined,
      });
    } else if (platform === "instagram_feed" || platform === "instagram_story") {
      if (!publicImageUrl) {
        result = { success: false, error: "No public image URL available for Instagram" };
      } else {
        result = await publishToInstagram({
          accessToken: decryptedAccessToken,
          igUserId: socialAccount.accountId,
          caption,
          imageUrl: publicImageUrl,
          platform,
        });
      }
    } else if (platform === "linkedin") {
      result = await publishToLinkedIn({
        accessToken: decryptedAccessToken,
        authorUrn: socialAccount.accountId,
        text: caption,
        imagePath: imagePath || undefined,
      });
    } else if (platform === "tiktok") {
      result = await publishToTikTok({
        accessToken: decryptedAccessToken,
        caption,
        imagePath: videoPath ? undefined : (imagePath || undefined),
        videoPath: videoPath || undefined,
      });
    } else if (platform === "youtube") {
      const videoUrl = variant.videoUrl || variant.mergedVideoUrl;
      if (!videoUrl) {
        result = { success: false, error: "No video file available for YouTube upload" };
      } else {
        const videoFilename = videoUrl.split("/").pop();
        const videoFilePath = videoFilename ? `uploads/generated/${videoFilename}` : null;
        if (!videoFilePath) {
          result = { success: false, error: "Could not resolve video file path for YouTube" };
        } else {
          const hashtagMatches = caption.match(/#[\w]+/g);
          const tags = hashtagMatches ? hashtagMatches.map(t => t.slice(1)) : [];
          result = await publishToYouTube({
            accessToken: decryptedAccessToken,
            title: variant.headlineText || caption.substring(0, 100) || "Untitled Video",
            description: caption,
            tags,
            videoPath: videoFilePath,
            publishAt: entry.scheduledAt,
          });
        }
      }
    } else {
      result = { success: false, error: `Unsupported platform: ${platform}` };
    }
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : "Unknown publish error" };
  }

  await db.transaction(async (tx) => {
    if (result.success) {
      const [updated] = await tx.update(calendarEntriesTable)
        .set({
          publishStatus: "published",
          publishedAt: new Date(),
          publishError: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(calendarEntriesTable.id, entryId),
          eq(calendarEntriesTable.publishStatus, "publishing")
        ))
        .returning();
      if (updated) {
        logger.info({ entryId, platform, postId: result.platformPostId }, "Entry published successfully");
      }
    } else {
      const permanent = isPermanentFailure(result.httpStatus);
      const [updated] = await tx.update(calendarEntriesTable)
        .set({
          publishStatus: "failed",
          publishError: result.error || "Unknown error",
          retryCount: permanent ? MAX_RETRIES : newRetryCount,
          updatedAt: new Date(),
        })
        .where(and(
          eq(calendarEntriesTable.id, entryId),
          eq(calendarEntriesTable.publishStatus, "publishing")
        ))
        .returning();
      if (updated) {
        if (permanent) {
          logger.error({ entryId, platform, error: result.error }, "Entry publish permanently failed — will not retry");
        } else {
          logger.warn({ entryId, platform, error: result.error, retryCount: newRetryCount }, "Entry publish failed (transient) — will retry");
        }
      }
    }
  });
}

async function pollAndPublish(): Promise<void> {
  try {
    const now = new Date();

    const readyEntries = await db.select()
      .from(calendarEntriesTable)
      .where(
        and(
          lte(calendarEntriesTable.scheduledAt, now),
          eq(calendarEntriesTable.publishStatus, "scheduled")
        )
      );

    const failedEntries = await db.select()
      .from(calendarEntriesTable)
      .where(eq(calendarEntriesTable.publishStatus, "failed"));

    const retriableEntries = failedEntries.filter(entry => {
      if ((entry.retryCount || 0) >= MAX_RETRIES) return false;
      if (!entry.socialAccountId) return false;
      const backoffMs = getBackoffMs(entry.retryCount || 0);
      const lastAttempt = entry.updatedAt || entry.createdAt;
      return (now.getTime() - lastAttempt.getTime()) >= backoffMs;
    });

    const allEntries = [...readyEntries, ...retriableEntries];

    if (allEntries.length === 0) return;

    logger.info({ count: allEntries.length, ready: readyEntries.length, retries: retriableEntries.length }, "Processing entries for publishing");

    for (const entry of allEntries) {
      await publishEntry(entry.id);
    }
  } catch (err) {
    logger.error({ err }, "Publish scheduler poll error");
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startPublishScheduler(): void {
  if (intervalId) {
    logger.warn("Publish scheduler already running");
    return;
  }

  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Starting publish scheduler");
  intervalId = setInterval(pollAndPublish, POLL_INTERVAL_MS);

  pollAndPublish();
}

export function stopPublishScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info("Publish scheduler stopped");
  }
}

export { publishEntry };
