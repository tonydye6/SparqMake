import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, creativesTable, creativeVariantsTable, costLogsTable } from "@workspace/db";
import { assembleContext, type SelectedAssetRef } from "../services/context-assembly.js";
import { generateVideo, estimateVideoCost, VIDEO_CONFIGS } from "../services/video-generation.js";
import { generateMusic, generateSFX, estimateElevenLabsCost } from "../services/elevenlabs.js";
import { mergeAudioVideo, type MergeMode } from "../services/audio-merge.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import multer from "multer";
import { generationLimiter } from "../lib/rate-limit.js";

function clampVolume(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, n));
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
  const creativeId = req.params.id;
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

    ensureDir(UPLOADS_DIR);

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
          fs.copyFileSync(videoTmpPath, path.join(UPLOADS_DIR, videoFilename));
        } catch (copyErr) {
          console.error(`Video file copy failed for ${orientation}:`, copyErr instanceof Error ? copyErr.message : copyErr);
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
          model: "veo-2.0-generate-001",
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
  const { id: creativeId, variantId } = req.params;
  const { type, prompt, mode, audioVolume, videoVolume } = req.body;

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

  try {
    let audioBuffer: Buffer | undefined;
    let audioSource = type || "veo_native";

    if (type === "music" && prompt) {
      const result = await generateMusic(prompt);
      audioBuffer = result.audioBuffer;
      audioSource = "elevenlabs_music";
    } else if (type === "sfx" && prompt) {
      const result = await generateSFX(prompt);
      audioBuffer = result.audioBuffer;
      audioSource = "elevenlabs_sfx";
    } else if (type === "mute") {
      audioSource = "mute";
    }

    ensureDir(UPLOADS_DIR);

    let audioUrl: string | null = null;
    if (audioBuffer) {
      const audioFilename = `${creativeId}_${variantId}_audio_${Date.now()}.mp3`;
      const audioPath = path.join(UPLOADS_DIR, audioFilename);
      fs.writeFileSync(audioPath, audioBuffer);
      audioUrl = `/api/files/generated/${audioFilename}`;

      await db.insert(costLogsTable).values({
        creativeId,
        service: "elevenlabs",
        operation: type === "music" ? "music_generation" : "sfx_generation",
        model: "elevenlabs",
        costUsd: estimateElevenLabsCost(),
      });
    }

    const videoFilename = variant.videoUrl.replace("/api/files/generated/", "");
    const videoPath = path.join(UPLOADS_DIR, videoFilename);

    if (!fs.existsSync(videoPath)) {
      res.status(400).json({ error: "Video file not found" });
      return;
    }

    const videoBuffer = fs.readFileSync(videoPath);
    const mergeMode: MergeMode = type === "mute" ? "mute" : (mode || "replace") as MergeMode;

    const mergedBuffer = await mergeAudioVideo({
      videoBuffer,
      audioBuffer,
      mode: mergeMode,
      audioVolume: clampVolume(audioVolume, 1.0),
      videoVolume: clampVolume(videoVolume, 0.3),
    });

    const mergedFilename = `${creativeId}_${variantId}_merged_${Date.now()}.mp4`;
    const mergedPath = path.join(UPLOADS_DIR, mergedFilename);
    fs.writeFileSync(mergedPath, mergedBuffer);
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
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Audio processing failed: ${message}` });
  }
});

router.post("/creatives/:id/variants/:variantId/audio-upload", generationLimiter, audioUpload.single("audio"), async (req: Request, res: Response): Promise<void> => {
  const { id: creativeId, variantId } = req.params;
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

  try {
    ensureDir(UPLOADS_DIR);

    const audioFilename = `${creativeId}_${variantId}_custom_${Date.now()}.mp3`;
    const audioPath = path.join(UPLOADS_DIR, audioFilename);
    fs.writeFileSync(audioPath, req.file.buffer);
    const audioUrl = `/api/files/generated/${audioFilename}`;

    const videoFilename = variant.videoUrl.replace("/api/files/generated/", "");
    const videoPath = path.join(UPLOADS_DIR, videoFilename);

    if (!fs.existsSync(videoPath)) {
      res.status(400).json({ error: "Video file not found" });
      return;
    }

    const videoBuffer = fs.readFileSync(videoPath);

    const mergedBuffer = await mergeAudioVideo({
      videoBuffer,
      audioBuffer: req.file.buffer,
      mode,
    });

    const mergedFilename = `${creativeId}_${variantId}_merged_${Date.now()}.mp4`;
    const mergedPath = path.join(UPLOADS_DIR, mergedFilename);
    fs.writeFileSync(mergedPath, mergedBuffer);
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
