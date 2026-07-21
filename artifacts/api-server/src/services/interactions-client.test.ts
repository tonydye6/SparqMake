/**
 * Unit tests for interactions-client request shape.
 *
 * Verifies that reference images are passed as content blocks inside `input`
 * (not as a top-level `media` array) per SDK 2.12.0+ requirements.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Capture the raw requestBody passed to ai.interactions.create
// ---------------------------------------------------------------------------

let lastCreateCall: Record<string, unknown> | null = null;

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: {
    interactions: {
      create: vi.fn().mockImplementation((body: Record<string, unknown>) => {
        lastCreateCall = body;
        return Promise.resolve({
          id: "iact-test-1",
          output_image: {
            data: Buffer.from("fake-image").toString("base64"),
            mime_type: "image/png",
          },
        });
      }),
    },
  },
}));

vi.mock("../lib/ai-config.js", () => ({
  COPILOT_MODELS: {
    NANO_BANANA_MODEL: "nano-banana-test",
    OMNI_VIDEO_MODEL: "omni-video-test",
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runImageInteraction, runVideoInteraction } from "./interactions-client.js";
import { ai } from "@workspace/integrations-gemini-ai";

beforeEach(() => {
  lastCreateCall = null;
  vi.clearAllMocks();
  vi.mocked(ai.interactions.create).mockImplementation((body: Record<string, unknown>) => {
    lastCreateCall = body;
    return Promise.resolve({
      id: "iact-test-1",
      output_image: {
        data: Buffer.from("fake-image").toString("base64"),
        mime_type: "image/png",
      },
    }) as ReturnType<typeof ai.interactions.create>;
  });
});

// ---------------------------------------------------------------------------
// runImageInteraction — request shape
// ---------------------------------------------------------------------------

describe("runImageInteraction request shape", () => {
  it("sends input as a plain string when no slots are provided", async () => {
    await runImageInteraction({ prompt: "A bright product shot", slots: [] });

    expect(lastCreateCall).not.toBeNull();
    expect(lastCreateCall!.input).toBe("A bright product shot");
    expect(lastCreateCall!.media).toBeUndefined();
  });

  it("sends input as a content-block array when slots are present", async () => {
    const slots = [
      {
        imageBuffer: Buffer.from("ref-image-1"),
        mimeType: "image/png",
        slot: "character" as const,
        description: "Brand mascot",
      },
    ];

    await runImageInteraction({ prompt: "Feature the mascot", slots });

    expect(lastCreateCall).not.toBeNull();
    expect(Array.isArray(lastCreateCall!.input)).toBe(true);
    expect(lastCreateCall!.media).toBeUndefined();
  });

  it("first content block is the text prompt when slots are provided", async () => {
    const slots = [
      {
        imageBuffer: Buffer.from("style-ref"),
        mimeType: "image/jpeg",
        slot: "style" as const,
      },
    ];

    await runImageInteraction({ prompt: "Minimal clean style", slots });

    const input = lastCreateCall!.input as Array<{ type: string; text?: string }>;
    expect(input[0].type).toBe("text");
    expect(input[0].text).toContain("Minimal clean style");
  });

  it("subsequent content blocks are image blocks with base64 data", async () => {
    const imageData = Buffer.from("my-image-bytes");
    const slots = [
      {
        imageBuffer: imageData,
        mimeType: "image/png",
        slot: "object" as const,
        description: "Product bottle",
      },
    ];

    await runImageInteraction({ prompt: "Showcase the product", slots });

    const input = lastCreateCall!.input as Array<{ type: string; data?: string; mime_type?: string }>;
    expect(input.length).toBe(2);
    expect(input[1].type).toBe("image");
    expect(input[1].data).toBe(imageData.toString("base64"));
    expect(input[1].mime_type).toBe("image/png");
  });

  it("produces N+1 content blocks for N reference slots (1 text + N images)", async () => {
    const slots = [
      { imageBuffer: Buffer.from("a"), mimeType: "image/png", slot: "character" as const },
      { imageBuffer: Buffer.from("b"), mimeType: "image/jpeg", slot: "style" as const },
      { imageBuffer: Buffer.from("c"), mimeType: "image/png", slot: "object" as const },
    ];

    await runImageInteraction({ prompt: "Three references", slots });

    const input = lastCreateCall!.input as unknown[];
    expect(input.length).toBe(4); // 1 text + 3 images
  });

  it("slot description and role context is embedded in the text block", async () => {
    const slots = [
      {
        imageBuffer: Buffer.from("char"),
        mimeType: "image/png",
        slot: "character" as const,
        description: "Founder headshot",
      },
      {
        imageBuffer: Buffer.from("sty"),
        mimeType: "image/png",
        slot: "style" as const,
        description: "Warm earth tones",
      },
    ];

    await runImageInteraction({ prompt: "Brand announcement", slots });

    const textBlock = (lastCreateCall!.input as Array<{ type: string; text?: string }>)[0];
    expect(textBlock.text).toContain("Subject/character reference");
    expect(textBlock.text).toContain("Founder headshot");
    expect(textBlock.text).toContain("Style reference");
    expect(textBlock.text).toContain("Warm earth tones");
  });

  it("preserves previous_interaction_id when provided", async () => {
    await runImageInteraction({
      prompt: "Edit the image",
      slots: [],
      previousInteractionId: "iact-prev-123",
    });

    expect(lastCreateCall!.previous_interaction_id).toBe("iact-prev-123");
  });

  it("does not set previous_interaction_id when null", async () => {
    await runImageInteraction({
      prompt: "Fresh generation",
      slots: [],
      previousInteractionId: null,
    });

    expect(lastCreateCall!.previous_interaction_id).toBeUndefined();
  });

  it("returns the interactionId and imageBuffer from the response", async () => {
    const result = await runImageInteraction({ prompt: "Test", slots: [] });

    expect(result.interactionId).toBe("iact-test-1");
    expect(result.imageBuffer).toBeInstanceOf(Buffer);
    expect(result.mimeType).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// runVideoInteraction — request shape
// ---------------------------------------------------------------------------

describe("runVideoInteraction request shape", () => {
  beforeEach(() => {
    vi.mocked(ai.interactions.create).mockImplementation((body: Record<string, unknown>) => {
      lastCreateCall = body;
      return Promise.resolve({
        id: "viact-test-1",
        output_video: {
          data: Buffer.from("fake-video").toString("base64"),
          mime_type: "video/mp4",
        },
      }) as ReturnType<typeof ai.interactions.create>;
    });
  });

  it("sends input as a plain string when no seed image is provided", async () => {
    await runVideoInteraction({ prompt: "Animate the scene", imageBuffer: null });

    expect(lastCreateCall).not.toBeNull();
    expect(lastCreateCall!.input).toBe("Animate the scene");
    expect(lastCreateCall!.media).toBeUndefined();
  });

  it("sends input as a content-block array when seed image is provided", async () => {
    const imgBuf = Buffer.from("seed-image-bytes");
    await runVideoInteraction({
      prompt: "Convert to video",
      imageBuffer: imgBuf,
      imageMimeType: "image/png",
    });

    expect(lastCreateCall).not.toBeNull();
    expect(Array.isArray(lastCreateCall!.input)).toBe(true);
    expect(lastCreateCall!.media).toBeUndefined();
  });

  it("first content block is text prompt, second is the seed image", async () => {
    const imgBuf = Buffer.from("seed-bytes");
    await runVideoInteraction({
      prompt: "Make it move",
      imageBuffer: imgBuf,
      imageMimeType: "image/jpeg",
    });

    const input = lastCreateCall!.input as Array<{ type: string; text?: string; data?: string; mime_type?: string }>;
    expect(input.length).toBe(2);
    expect(input[0].type).toBe("text");
    expect(input[0].text).toBe("Make it move");
    expect(input[1].type).toBe("image");
    expect(input[1].data).toBe(imgBuf.toString("base64"));
    expect(input[1].mime_type).toBe("image/jpeg");
  });

  it("defaults mime_type to image/png when imageMimeType is not provided", async () => {
    await runVideoInteraction({
      prompt: "Animate",
      imageBuffer: Buffer.from("img"),
    });

    const input = lastCreateCall!.input as Array<{ type: string; mime_type?: string }>;
    expect(input[1].mime_type).toBe("image/png");
  });

  it("preserves previous_interaction_id for chained video edits", async () => {
    await runVideoInteraction({
      prompt: "Edit the video",
      imageBuffer: null,
      previousInteractionId: "viact-prev-456",
    });

    expect(lastCreateCall!.previous_interaction_id).toBe("viact-prev-456");
  });

  it("returns the interactionId and videoBuffer from the response", async () => {
    const result = await runVideoInteraction({
      prompt: "Test",
      imageBuffer: null,
    });

    expect(result.interactionId).toBe("viact-test-1");
    expect(result.videoBuffer).toBeInstanceOf(Buffer);
    expect(result.mimeType).toBe("video/mp4");
  });
});
