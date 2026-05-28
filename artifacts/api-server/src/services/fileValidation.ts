import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import * as fs from "fs";
import * as path from "path";

export type FileCategory = "image" | "video" | "audio" | "font" | "pdf";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/wav", "audio/x-wav"]);
const FONT_MIMES = new Set([
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
  "application/x-font-woff2",
  "application/x-font-ttf",
  "application/font-woff",
  "application/font-woff2",
  "application/font-sfnt",
  "application/vnd.ms-fontobject",
]);
const PDF_MIMES = new Set(["application/pdf"]);

const FONT_EXTS = new Set([".woff2", ".woff", ".ttf", ".otf"]);

function normalizeMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "image/jpg") return "image/jpeg";
  if (m === "audio/x-wav" || m === "audio/wave" || m === "audio/vnd.wave") return "audio/wav";
  if (m === "audio/mp3") return "audio/mpeg";
  if (m === "video/mov") return "video/quicktime";
  if (m === "application/x-font-woff2") return "font/woff2";
  if (m === "application/x-font-ttf") return "font/ttf";
  if (m === "application/font-woff") return "font/woff";
  if (m === "application/font-woff2") return "font/woff2";
  return m;
}

function categoryForMime(mime: string): FileCategory | null {
  const m = normalizeMime(mime);
  if (IMAGE_MIMES.has(m)) return "image";
  if (VIDEO_MIMES.has(m)) return "video";
  if (AUDIO_MIMES.has(m)) return "audio";
  if (FONT_MIMES.has(m)) return "font";
  if (PDF_MIMES.has(m)) return "pdf";
  return null;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  detectedMime?: string;
}

/**
 * Validates an uploaded file by inspecting its magic bytes. The file's true
 * type (after alias normalization) must match the claimed MIME exactly, AND
 * the claimed type must fall within `allowedCategories`. On any mismatch the
 * file is removed from disk and `ok: false` is returned.
 *
 * Fonts (woff/woff2/ttf/otf) are not detected by the `file-type` library, so
 * font validation is delegated to `validateFontFileBytes` which checks the
 * 4-byte font signature directly.
 */
export async function validateUploadedFile(
  filePath: string,
  claimedMime: string,
  originalName: string,
  allowedCategories: ReadonlyArray<FileCategory>,
): Promise<ValidationResult> {
  const cleanup = () => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  };

  const normalizedClaimed = normalizeMime(claimedMime);
  const claimedCategory = categoryForMime(claimedMime);
  if (!claimedCategory || !allowedCategories.includes(claimedCategory)) {
    cleanup();
    return { ok: false, error: `File type ${claimedMime} not allowed` };
  }

  if (claimedCategory === "font") {
    const ext = path.extname(originalName).toLowerCase();
    if (!FONT_EXTS.has(ext)) {
      cleanup();
      return { ok: false, error: "Invalid font file extension" };
    }
    const fontResult = await validateFontFileBytes(filePath, ext);
    if (!fontResult.ok) {
      cleanup();
      return fontResult;
    }
    // Make sure the claimed font MIME matches the extension we just verified.
    const extToMime: Record<string, string> = {
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
    };
    const expectedMime = extToMime[ext];
    if (expectedMime && normalizedClaimed !== expectedMime) {
      cleanup();
      return {
        ok: false,
        error: `Font file extension ${ext} does not match claimed MIME ${claimedMime}`,
      };
    }
    return { ok: true };
  }

  let detected;
  try {
    detected = await fileTypeFromFile(filePath);
  } catch (err) {
    cleanup();
    return {
      ok: false,
      error: `Could not read uploaded file: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  if (!detected) {
    cleanup();
    return { ok: false, error: "Could not determine file type from contents" };
  }

  const detectedNormalized = normalizeMime(detected.mime);
  const detectedCategory = categoryForMime(detected.mime);
  if (!detectedCategory || detectedCategory !== claimedCategory) {
    cleanup();
    return {
      ok: false,
      error: `File contents (${detected.mime}) do not match claimed type (${claimedMime})`,
      detectedMime: detected.mime,
    };
  }

  if (detectedNormalized !== normalizedClaimed) {
    cleanup();
    return {
      ok: false,
      error: `File contents (${detected.mime}) do not match claimed type (${claimedMime})`,
      detectedMime: detected.mime,
    };
  }

  return { ok: true, detectedMime: detected.mime };
}

/**
 * Buffer-based variant of `validateUploadedFile` for routes that use
 * `multer.memoryStorage()`. Inspects the first bytes of the buffer to confirm
 * the true file type matches the claimed MIME and falls within the allowed
 * categories. Font validation reuses the same 4-byte signature checks.
 *
 * Unlike the file-based variant, this does NOT touch the filesystem — the
 * caller is responsible for discarding the buffer on failure.
 */
export async function validateUploadedBuffer(
  buffer: Buffer,
  claimedMime: string,
  originalName: string,
  allowedCategories: ReadonlyArray<FileCategory>,
): Promise<ValidationResult> {
  const normalizedClaimed = normalizeMime(claimedMime);
  const claimedCategory = categoryForMime(claimedMime);
  if (!claimedCategory || !allowedCategories.includes(claimedCategory)) {
    return { ok: false, error: `File type ${claimedMime} not allowed` };
  }

  if (claimedCategory === "font") {
    const ext = path.extname(originalName).toLowerCase();
    if (!FONT_EXTS.has(ext)) {
      return { ok: false, error: "Invalid font file extension" };
    }
    const fontResult = validateFontBufferBytes(buffer, ext);
    if (!fontResult.ok) return fontResult;
    const extToMime: Record<string, string> = {
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
    };
    const expectedMime = extToMime[ext];
    if (expectedMime && normalizedClaimed !== expectedMime) {
      return {
        ok: false,
        error: `Font file extension ${ext} does not match claimed MIME ${claimedMime}`,
      };
    }
    return { ok: true };
  }

  let detected;
  try {
    detected = await fileTypeFromBuffer(buffer);
  } catch (err) {
    return {
      ok: false,
      error: `Could not read uploaded file: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  if (!detected) {
    return { ok: false, error: "Could not determine file type from contents" };
  }

  const detectedNormalized = normalizeMime(detected.mime);
  const detectedCategory = categoryForMime(detected.mime);
  if (!detectedCategory || detectedCategory !== claimedCategory) {
    return {
      ok: false,
      error: `File contents (${detected.mime}) do not match claimed type (${claimedMime})`,
      detectedMime: detected.mime,
    };
  }

  if (detectedNormalized !== normalizedClaimed) {
    return {
      ok: false,
      error: `File contents (${detected.mime}) do not match claimed type (${claimedMime})`,
      detectedMime: detected.mime,
    };
  }

  return { ok: true, detectedMime: detected.mime };
}

function validateFontBufferBytes(buffer: Buffer, ext: string): ValidationResult {
  if (buffer.length < 4) {
    return { ok: false, error: "Uploaded font is too small to validate" };
  }
  const head = buffer.subarray(0, 4);
  const ascii = head.toString("ascii");
  const isWoff = ascii === "wOFF";
  const isWoff2 = ascii === "wOF2";
  const isOtf = ascii === "OTTO";
  const isTtf =
    ascii === "true" ||
    (head[0] === 0x00 && head[1] === 0x01 && head[2] === 0x00 && head[3] === 0x00);

  const expected: Record<string, boolean> = {
    ".woff": isWoff,
    ".woff2": isWoff2,
    ".otf": isOtf || isTtf,
    ".ttf": isTtf || isOtf,
  };

  if (!expected[ext]) {
    return {
      ok: false,
      error: `Font file contents do not match a valid ${ext} font signature`,
    };
  }
  return { ok: true };
}

/**
 * Lightweight content check for CSV uploads. `file-type` cannot detect CSV
 * (it's just plain text), so we look at the first KB of the buffer:
 *   1. Reject if it contains NUL bytes or a high ratio of non-printable bytes
 *      (a strong signal it's actually a binary file renamed to `.csv`).
 *   2. Reject if the prefix is not valid UTF-8.
 * The caller is expected to parse the CSV afterwards; structural validation
 * lives in the route's existing parser, which throws on malformed input.
 */
export function validateCsvBuffer(buffer: Buffer): ValidationResult {
  if (buffer.length === 0) {
    return { ok: false, error: "CSV file is empty" };
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));

  if (sample.includes(0x00)) {
    return { ok: false, error: "CSV file appears to contain binary data" };
  }

  let nonPrintable = 0;
  for (const byte of sample) {
    const isPrintable =
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte <= 0x7e) ||
      byte >= 0x80;
    if (!isPrintable) nonPrintable++;
  }
  if (nonPrintable / sample.length > 0.1) {
    return { ok: false, error: "CSV file appears to contain binary data" };
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return { ok: false, error: "CSV file is not valid UTF-8 text" };
  }

  return { ok: true };
}

/**
 * Validates the magic bytes of a font file. `file-type` doesn't reliably
 * detect web fonts, so we inspect the first 4 bytes ourselves.
 *   - woff:  "wOFF"
 *   - woff2: "wOF2"
 *   - ttf:   00 01 00 00  OR  "true"
 *   - otf:   "OTTO"
 */
export async function validateFontFileBytes(
  filePath: string,
  ext: string,
): Promise<ValidationResult> {
  let head: Buffer;
  try {
    const fd = await fs.promises.open(filePath, "r");
    try {
      const { buffer } = await fd.read(Buffer.alloc(4), 0, 4, 0);
      head = buffer;
    } finally {
      await fd.close();
    }
  } catch (err) {
    return {
      ok: false,
      error: `Could not read uploaded font: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  const ascii = head.toString("ascii");
  const isWoff = ascii === "wOFF";
  const isWoff2 = ascii === "wOF2";
  const isOtf = ascii === "OTTO";
  const isTtf =
    ascii === "true" ||
    (head[0] === 0x00 && head[1] === 0x01 && head[2] === 0x00 && head[3] === 0x00);

  const expected: Record<string, boolean> = {
    ".woff": isWoff,
    ".woff2": isWoff2,
    ".otf": isOtf || isTtf,
    ".ttf": isTtf || isOtf,
  };

  if (!expected[ext]) {
    return {
      ok: false,
      error: `Font file contents do not match a valid ${ext} font signature`,
    };
  }
  return { ok: true };
}
