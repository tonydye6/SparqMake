import { ai } from "@workspace/integrations-gemini-ai";
import { Modality } from "@google/genai";
import { AI_MODELS } from "../lib/ai-config.js";

// AI-integrated headline typography: instead of compositing plain text on top
// of a finished image, ask the image model to paint the headline INTO the
// scene as art-directed typography (matched lighting, perspective, energy —
// e.g. neon signage in an arena). Every render is verified by a vision/OCR
// check for correct spelling + legibility and retried with corrective
// prompting before the caller falls back to the overlay path.

export interface BrandTypographyGuidance {
  fontFamily?: string | null;
  colorPrimary?: string | null;
  colorSecondary?: string | null;
  colorAccent?: string | null;
  brandName?: string | null;
}

export class HeadlineRenderError extends Error {
  constructor(public readonly attempts: number, public readonly lastIssue: string | null) {
    super(
      `The image model could not render the headline legibly after ${attempts} attempt${attempts === 1 ? "" : "s"}` +
      (lastIssue ? ` (${lastIssue})` : "") + ".",
    );
    this.name = "HeadlineRenderError";
  }
}

export interface HeadlineRenderResult {
  buffer: Buffer;
  attempts: number;
  verified: boolean;
}

function buildRenderPrompt(headline: string, guidance: BrandTypographyGuidance, aspectLabel: string, correctiveNote?: string): string {
  const brandBits: string[] = [];
  if (guidance.fontFamily) brandBits.push(`The brand's typeface is "${guidance.fontFamily}" — match its character (weight, geometry) as closely as possible.`);
  const palette = [guidance.colorPrimary, guidance.colorSecondary, guidance.colorAccent].filter(Boolean);
  if (palette.length > 0) brandBits.push(`Prefer the brand palette for the type treatment: ${palette.join(", ")}.`);
  if (guidance.brandName) brandBits.push(`This is for the brand "${guidance.brandName}".`);

  return [
    `You are an award-winning art director. Integrate the following headline into this image as designed typography that belongs to the scene — matching its lighting, perspective, materials, and energy (for example: stadium signage, neon, painted lettering, bold poster type — whatever fits THIS image best).`,
    `HEADLINE (render EXACTLY these words, spelled EXACTLY like this, nothing more): "${headline}"`,
    `Placement: choose intelligent negative space that does not cover the primary subject's face or key action. The text must be large enough to read on a phone, fully inside the frame with comfortable margins (keep it out of the outer 8% of the frame), and never cut off.`,
    brandBits.join(" "),
    `Do not change the subject, composition, or scene beyond adding the typography (and any subtle supporting treatment like a glow or panel the type needs to stay legible). Do not add any other text, captions, or watermarks. Keep the ${aspectLabel} aspect ratio exactly.`,
    correctiveNote ? `PREVIOUS ATTEMPT FAILED: ${correctiveNote}. Fix this — spell the headline exactly as given, keep every word complete and clearly legible.` : "",
  ].filter(Boolean).join("\n\n");
}

async function requestRender(imageBuffer: Buffer, mimeType: string, prompt: string): Promise<Buffer | null> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 120_000);
  let response;
  try {
    response = await ai.models.generateContent({
      model: AI_MODELS.GEMINI_FLASH_IMAGE,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { data: imageBuffer.toString("base64"), mimeType: mimeType || "image/png" } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        abortSignal: abortController.signal,
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
  const part = response.candidates?.[0]?.content?.parts?.find(
    (p: { inlineData?: { data?: string } }) => p.inlineData,
  );
  return part?.inlineData?.data ? Buffer.from(part.inlineData.data, "base64") : null;
}

export interface HeadlineVerification {
  ok: boolean;
  issue: string | null;
}

// Vision/OCR check: does the rendered image contain the headline, spelled
// correctly, complete, and legible? Conservative on errors — an unreadable
// verifier response counts as a failure so we never ship unchecked text.
export async function verifyRenderedHeadline(imageBuffer: Buffer, headline: string): Promise<HeadlineVerification> {
  const prompt = `You are a strict proofreader. The image is supposed to contain this exact headline text (integrated into the artwork): "${headline}"

Check: (1) every word of the headline appears, spelled EXACTLY as given; (2) no words are missing, truncated, duplicated, or garbled; (3) the text is clearly legible; (4) no letters are cut off by the image edge.
Ignore case and minor stylistic punctuation differences. Ignore any other text in the image.

Return ONLY valid JSON, no markdown: {"ok": boolean, "issue": string|null} — issue is a short description of what is wrong when ok is false.`;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 60_000);
  try {
    let response;
    try {
      response = await ai.models.generateContent({
        model: AI_MODELS.GEMINI_FLASH_TEXT,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/png" } },
            ],
          },
        ],
        config: { abortSignal: abortController.signal },
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const text = response.candidates?.[0]?.content?.parts
      ?.filter((p: { text?: string }) => p.text)
      .map((p: { text?: string }) => p.text)
      .join("") || "";
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as { ok?: unknown; issue?: unknown };
    return { ok: parsed.ok === true, issue: typeof parsed.issue === "string" ? parsed.issue : null };
  } catch (err) {
    return { ok: false, issue: `verification failed: ${err instanceof Error ? err.message : err}` };
  }
}

export const MAX_HEADLINE_RENDER_ATTEMPTS = 3;

// Render the headline into the image and verify it, retrying with corrective
// prompting. Throws HeadlineRenderError when every attempt fails verification
// (callers fall back to the design-aware overlay). Each attempt costs one
// image call + one vision-verify call; `onAttempt` lets callers meter cost.
export async function renderHeadlineIntoImage(
  imageBuffer: Buffer,
  mimeType: string,
  headline: string,
  guidance: BrandTypographyGuidance,
  aspectLabel: string,
  onAttempt?: (attempt: number) => void,
): Promise<HeadlineRenderResult> {
  let correctiveNote: string | undefined;
  let lastIssue: string | null = null;

  for (let attempt = 1; attempt <= MAX_HEADLINE_RENDER_ATTEMPTS; attempt++) {
    onAttempt?.(attempt);
    const prompt = buildRenderPrompt(headline, guidance, aspectLabel, correctiveNote);
    let rendered: Buffer | null = null;
    try {
      rendered = await requestRender(imageBuffer, mimeType, prompt);
    } catch (err) {
      // Transport/API error: surface immediately rather than burning retries.
      throw err;
    }
    if (!rendered) {
      lastIssue = "model returned no image";
      correctiveNote = undefined;
      continue;
    }
    const verification = await verifyRenderedHeadline(rendered, headline);
    if (verification.ok) {
      return { buffer: rendered, attempts: attempt, verified: true };
    }
    lastIssue = verification.issue || "text failed verification";
    correctiveNote = lastIssue;
    console.warn(`Headline render attempt ${attempt}/${MAX_HEADLINE_RENDER_ATTEMPTS} failed verification: ${lastIssue}`);
  }

  throw new HeadlineRenderError(MAX_HEADLINE_RENDER_ATTEMPTS, lastIssue);
}
