import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execFileAsync = promisify(execFile);

export type MergeMode = "replace" | "mix" | "mute";

export interface MergeOptions {
  videoBuffer: Buffer;
  audioBuffer?: Buffer;
  mode: MergeMode;
  audioVolume?: number;
  videoVolume?: number;
}

export async function mergeAudioVideo(options: MergeOptions): Promise<Buffer> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sparqmake-merge-"));
  const videoPath = path.join(tmpDir, "input.mp4");
  const audioPath = path.join(tmpDir, "audio.mp3");
  const outputPath = path.join(tmpDir, "output.mp4");

  try {
    await fs.promises.writeFile(videoPath, options.videoBuffer);

    if (options.mode === "mute") {
      await execFileAsync("ffmpeg", [
        "-i", videoPath,
        "-an",
        "-c:v", "copy",
        "-y",
        outputPath,
      ]);
    } else if (options.mode === "replace" && options.audioBuffer) {
      await fs.promises.writeFile(audioPath, options.audioBuffer);
      await execFileAsync("ffmpeg", [
        "-i", videoPath,
        "-i", audioPath,
        "-c:v", "copy",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-shortest",
        "-y",
        outputPath,
      ]);
    } else if (options.mode === "mix" && options.audioBuffer) {
      await fs.promises.writeFile(audioPath, options.audioBuffer);
      const clamp = (v: number | undefined, fallback: number): number => {
        const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
        return Math.max(0, Math.min(10, n));
      };
      const vidVol = clamp(options.videoVolume, 0.3);
      const audVol = clamp(options.audioVolume, 1.0);
      await execFileAsync("ffmpeg", [
        "-i", videoPath,
        "-i", audioPath,
        "-c:v", "copy",
        "-filter_complex",
        `[0:a]volume=${vidVol}[a0];[1:a]volume=${audVol}[a1];[a0][a1]amix=inputs=2:duration=shortest[aout]`,
        "-map", "0:v:0",
        "-map", "[aout]",
        "-shortest",
        "-y",
        outputPath,
      ]);
    } else {
      await fs.promises.copyFile(videoPath, outputPath);
    }

    const result = await fs.promises.readFile(outputPath);
    return result;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}
