import { str } from "../lib/http-params.js";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, gte, sql } from "drizzle-orm";
import { db, creativesTable, creativeVariantsTable, costLogsTable, appSettingsTable } from "@workspace/db";
import { assembleContext, type SelectedAssetRef } from "../services/context-assembly.js";
import { generateVideo, estimateVideoCost, VIDEO_CONFIGS } from "../services/video-generation.js";
import { generateMusic, generateSFX, estimateElevenLabsCost } from "../services/elevenlabs.js";
import { mergeAudioVideo, type MergeMode } from "../services/audio-merge.js";
import { writeBuffer, writeFromFile, readBuffer } from "../services/storage.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import multer from "multer";
import { generationLimiter } from "../lib/rate-limit.js";
import { AI_MODELS } from "../lib/ai-config.js";
import { validateUploadedBuffer } from "../services/fileValidation.js";

function clampVolume(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, n));
}

// Clip-matched audio duration: Veo clips are generated at 6s (see
// video-generation.ts), so audio defaults to the same length. Clamp keeps the
// value inside ElevenLabs' supported range.
const DEFAULT_AUDIO_DURATION_SEC = 6;
function clampDuration(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  if (!Number.isFinite(n)) return DEFAULT_AUDIO_DURATION_SEC;
  return Math.max(1, Math.min(22, Math.round(n)));
}

// Reserve daily-budget headroom for an ElevenLabs call (advisory-locked, same
// scheme and lock key as the /generate routes). Returns the reservation row id
// to settle later, or an `ok:false` result the caller turns into a 429.
async function reserveAudioBudget(
  creativeId: string,
): Promise<{ ok: true; reservationId: string | null } | { ok: false; todaySpend: number; threshold: number }> {
  const [thresholdRow] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "dailyCostThreshold"));
  const budgetThreshold = thresholdRow ? parseFloat(thresholdRow.value) : null;
  if (budgetThreshold === null || isNaN(budgetThreshold) || budgetThreshold <= 0) {
    return { ok: true, reservationId: null };
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const estimatedCost = estimateElevenLabsCost();
  const reservationId = crypto.randomUUID();

  const result = await db.transaction(async (tx) => {
    const BUDGET_LOCK_KEY = 100001;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
    const [todayResult] = await tx.select({
      totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)`,
    }).from(costLogsTable).where(gte(costLogsTable.createdAt, todayStart));
    const currentSpend = Number(todayResult?.totalCost || 0);
    if (currentSpend + estimatedCost > budgetThreshold) {
      return { exceeded: true as const, todaySpend: currentSpend };
    }
    await tx.insert(costLogsTable).values({
      id: reservationId,
      creativeId,
      service: "system",
      operation: "budget_reservation",
      model: null,
      costUsd: estimatedCost,
    });
    return { exceeded: false as const, todaySpend: currentSpend };
  });

  if (result.exceeded) return { ok: false, todaySpend: result.todaySpend, threshold: budgetThreshold };
  return { ok: true, reservationId };
}

const router: IRouter = Router();
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads", "generated");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only MP3 and WAV audio files are allowed"));
    }
  },
});

router.post("/creatives/:id/generate-video", generationLimiter, async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id);
  const { orientations } = req.body;

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }
  if (!campaign.templateId) {
    res.status(400).json({ error: "Creative must have a template selected" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const abortController = new AbortController();
  let clientDisconnected = false;

  req.on("close", () => {
    clientDisconnected = true;
    abortController.abort();
  });

  function sendEvent(event: string, data: Record<string, unknown>) {
    if (clientDisconnected) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const validOrientations = ["landscape", "portrait"];
    const rawOrientations = orientations || ["landscape", "portrait"];
    const selectedOrientations: Array<"landscape" | "portrait"> = (Array.isArray(rawOrientations) ? rawOrientations : [rawOrientations]).filter(
      (o: string) => validOrientations.includes(o)
    ) as Array<"landscape" | "portrait">;
    if (selectedOrientations.length === 0) {
      sendEvent("error", { message: "No valid orientations specified" });
      res.end();
      return;
    }

    sendEvent("progress", { step: "context", message: "Assembling context..." });
    const selectedAssets = (campaign.selectedAssets || []) as SelectedAssetRef[];
    const ctx = await assembleContext({
      brandId: campaign.brandId,
      templateId: campaign.templateId,
      selectedAssets,
      selectedHashtagSetIds: (campaign.selectedHashtagSets || []) as string[],
      briefText: campaign.briefText || undefined,
      referenceAnalysis: campaign.referenceAnalysis as Record<string, unknown> | null,
    });

    for (const orientation of selectedOrientations) {
      if (clientDisconnected) break;

      sendEvent("video_progress", { orientation, status: "started", message: `Generating ${orientation} video...` });

      let videoTmpDir: string | null = null;
      try {
        const result = await generateVideo(ctx, orientation, abortController.signal);

        if (clientDisconnected) break;

        videoTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparq-video-"));
        const videoFilename = `${creativeId}_video_${orientation}_${Date.now()}.mp4`;
        const videoTmpPath = path.join(videoTmpDir, videoFilename);
        fs.writeFileSync(videoTmpPath, result.videoBuffer);

        const videoUrl = `/api/files/generated/${videoFilename}`;

        const platform = orientation === "landscape" ? "twitter" : "instagram_story";
        const existingVariants = await db.select().from(creativeVariantsTable)
          .where(eq(creativeVariantsTable.creativeId, creativeId));

        const matchingVariant = existingVariants.find(v => v.platform === platform);

        try {
          await writeFromFile("generated", videoFilename, videoTmpPath);
        } catch (copyErr) {
          console.error(`Video file save failed for ${orientation}:`, copyErr instanceof Error ? copyErr.message : copyErr);
          fs.rmSync(videoTmpDir, { recursive: true, force: true });
          videoTmpDir = null;
          throw new Error(`Failed to save video file for ${orientation}. Please try again.`);
        }
        fs.rmSync(videoTmpDir, { recursive: true, force: true });
        videoTmpDir = null;

        if (matchingVariant) {
          await db.update(creativeVariantsTable)
            .set({ videoUrl, audioSource: "veo_native", updatedAt: new Date() })
            .where(eq(creativeVariantsTable.id, matchingVariant.id));
        } else {
          await db.insert(creativeVariantsTable).values({
            creativeId,
            platform: `video_${orientation}`,
            aspectRatio: result.aspectRatio,
            videoUrl,
            audioSource: "veo_native",
            caption: "",
            status: "generated",
          });
        }

        sendEvent("video_progress", { orientation, status: "completed", videoUrl });

        const cost = estimateVideoCost(1);
        await db.insert(costLogsTable).values({
          creativeId,
          service: "gemini",
          operation: "video_generation",
          model: AI_MODELS.VEO_VIDEO,
          costUsd: cost,
        });
      } catch (error) {
        if (clientDisconnected) break;
        const message = error instanceof Error ? error.message : String(error);
        sendEvent("video_progress", { orientation, status: "failed", error: message });
        if (videoTmpDir) {
          try { fs.rmSync(videoTmpDir, { recursive: true, force: true }); } catch {}
        }
      }
    }

    if (!clientDisconnected) {
      sendEvent("complete", { message: "Video generation complete!" });
    }
  } catch (error) {
    if (!clientDisconnected) {
      const message = error instanceof Error ? error.message : String(error);
      sendEvent("error", { message: `Video generation failed: ${message}` });
    }
  } finally {
    res.end();
  }
});

router.post("/creatives/:id/variants/:variantId/audio", generationLimiter, async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);
  const { type, prompt, mode, audioVolume, videoVolume, durationSeconds } = req.body;

  const [variant] = await db.select().from(creativeVariantsTable)
    .where(eq(creativeVariantsTable.id, variantId));
  if (!variant || variant.creativeId !== creativeId) {
    res.status(404).json({ error: "Variant not found" });
    return;
  }

  if (!variant.videoUrl) {
    res.status(400).json({ error: "Variant has no video to add audio to" });
    return;
  }

  const validTypes = ["music", "sfx", "mute", "veo_native"];
  if (type && !validTypes.includes(type)) {
    res.status(400).json({ error: `Invalid audio type. Must be one of: ${validTypes.join(", ")}` });
    return;
  }

  const validModes = ["replace", "mix"];
  if (mode && !validModes.includes(mode)) {
    res.status(400).json({ error: `Invalid merge mode. Must be one of: ${validModes.join(", ")}` });
    return;
  }

  if ((type === "music" || type === "sfx") && !prompt) {
    res.status(400).json({ error: `A prompt is required for ${type} audio generation` });
    return;
  }

  // ElevenLabs generation costs money — gate it behind the same daily-budget
  // reservation scheme as image/caption generation. Mute/veo_native are free.
  const needsGeneration = type === "music" || type === "sfx";
  let reservationId: string | null = null;
  if (needsGeneration) {
    const budget = await reserveAudioBudget(creativeId);
    if (!budget.ok) {
      res.status(429).json({
        error: "Daily budget exceeded",
        todaySpend: budget.todaySpend,
        threshold: budget.threshold,
        message: `Today's spend ($${budget.todaySpend.toFixed(2)}) has reached the daily budget limit ($${budget.threshold.toFixed(2)}). Increase the limit in Cost Dashboard settings or wait until tomorrow.`,
      });
      return;
    }
    reservationId = budget.reservationId;
  }

  try {
    let audioBuffer: Buffer | undefined;
    let audioSource = type || "veo_native";
    const duration = clampDuration(durationSeconds);

    if (type === "music" && prompt) {
      const result = await generateMusic(prompt, duration);
      audioBuffer = result.audioBuffer;
      audioSource = "elevenlabs_music";
    } else if (type === "sfx" && prompt) {
      const result = await generateSFX(prompt, duration);
      audioBuffer = result.audioBuffer;
      audioSource = "elevenlabs_sfx";
    } else if (type === "mute") {
      audioSource = "mute";
    }

    let audioUrl: string | null = null;
    if (audioBuffer) {
      const audioFilename = `${creativeId}_${variantId}_audio_${Date.now()}.mp3`;
      await writeBuffer("generated", audioFilename, audioBuffer);
      audioUrl = `/api/files/generated/${audioFilename}`;

      // Settle the reservation: swap the placeholder row for the real cost log
      // in one transaction so the daily total never double-counts.
      await db.transaction(async (tx) => {
        if (reservationId) {
          await tx.delete(costLogsTable).where(eq(costLogsTable.id, reservationId));
        }
        await tx.insert(costLogsTable).values({
          creativeId,
          service: "elevenlabs",
          operation: type === "music" ? "music_generation" : "sfx_generation",
          model: "elevenlabs",
          costUsd: estimateElevenLabsCost(),
        });
      });
      reservationId = null;
    }

    const videoFilename = variant.videoUrl.replace("/api/files/generated/", "");
    const videoBuffer = await readBuffer({ namespace: "generated", filename: videoFilename });

    if (!videoBuffer) {
      res.status(400).json({ error: "Video file not found" });
      return;
    }

    const mergeMode: MergeMode = type === "mute" ? "mute" : (mode || "replace") as MergeMode;

    const mergedBuffer = await mergeAudioVideo({
      videoBuffer,
      audioBuffer,
      mode: mergeMode,
      audioVolume: clampVolume(audioVolume, 1.0),
      videoVolume: clampVolume(videoVolume, 0.3),
    });

    const mergedFilename = `${creativeId}_${variantId}_merged_${Date.now()}.mp4`;
    await writeBuffer("generated", mergedFilename, mergedBuffer);
    const mergedVideoUrl = `/api/files/generated/${mergedFilename}`;

    const [updated] = await db.update(creativeVariantsTable)
      .set({
        audioSource,
        audioUrl,
        mergedVideoUrl,
        updatedAt: new Date(),
      })
      .where(eq(creativeVariantsTable.id, variantId))
      .returning();

    res.json(updated);
  } catch (error) {
    // Release unused budget headroom if generation failed before settling.
    if (reservationId) {
      try {
        await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId));
      } catch {}
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Audio processing failed: ${message}` });
  }
});

router.post("/creatives/:id/variants/:variantId/audio-upload", generationLimiter, audioUpload.single("audio"), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);
  const mode = (req.body?.mode || "replace") as MergeMode;

  const [variant] = await db.select().from(creativeVariantsTable)
    .where(eq(creativeVariantsTable.id, variantId));
  if (!variant || variant.creativeId !== creativeId) {
    res.status(404).json({ error: "Variant not found" });
    return;
  }

  if (!variant.videoUrl) {
    res.status(400).json({ error: "Variant has no video" });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "No audio file provided" });
    return;
  }

  const audioValidation = await validateUploadedBuffer(
    req.file.buffer,
    req.file.mimetype,
    req.file.originalname,
    ["audio"],
  );
  if (!audioValidation.ok) {
    res.status(400).json({ error: audioValidation.error });
    return;
  }

  try {
    const audioFilename = `${creativeId}_${variantId}_custom_${Date.now()}.mp3`;
    await writeBuffer("generated", audioFilename, req.file.buffer);
    const audioUrl = `/api/files/generated/${audioFilename}`;

    const videoFilename = variant.videoUrl.replace("/api/files/generated/", "");
    const videoBuffer = await readBuffer({ namespace: "generated", filename: videoFilename });

    if (!videoBuffer) {
      res.status(400).json({ error: "Video file not found" });
      return;
    }

    const mergedBuffer = await mergeAudioVideo({
      videoBuffer,
      audioBuffer: req.file.buffer,
      mode,
    });

    const mergedFilename = `${creativeId}_${variantId}_merged_${Date.now()}.mp4`;
    await writeBuffer("generated", mergedFilename, mergedBuffer);
    const mergedVideoUrl = `/api/files/generated/${mergedFilename}`;

    const [updated] = await db.update(creativeVariantsTable)
      .set({
        audioSource: "custom_upload",
        audioUrl,
        mergedVideoUrl,
        updatedAt: new Date(),
      })
      .where(eq(creativeVariantsTable.id, variantId))
      .returning();

    res.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Audio upload failed: ${message}` });
  }
});

export default router;
