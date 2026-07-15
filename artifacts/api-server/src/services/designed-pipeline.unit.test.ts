import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { splitHeadline } from "./designed-take.js";
import { fitHeadlineBlock, loadDesignFont } from "./designed-compositor.js";
import { chromaKeyGreen, cutoutQuality } from "./subject-cutout.js";

describe("splitHeadline", () => {
  it("uppercases and keeps a short headline on one line", () => {
    expect(splitHeadline("Game Day")).toEqual(["GAME DAY"]);
  });

  it("splits a long headline into at most 3 lines", () => {
    const lines = splitHeadline("Friday night lights championship showdown at the stadium");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(24);
      expect(l).toBe(l.toUpperCase());
    }
  });

  it("falls back to GAME DAY on empty input", () => {
    expect(splitHeadline("   ")).toEqual(["GAME DAY"]);
  });

  it("truncates a single very long word to 24 chars", () => {
    const lines = splitHeadline("supercalifragilisticexpialidocious");
    expect(lines[0].length).toBeLessThanOrEqual(24);
  });
});

describe("fitHeadlineBlock", () => {
  const font = loadDesignFont("anton");

  it("uses max size when the line easily fits", () => {
    const { fontSize, lines } = fitHeadlineBlock(font, ["HI"], 5000, 120, 40);
    expect(fontSize).toBe(120);
    expect(lines).toHaveLength(1);
    expect(lines[0].width).toBeLessThanOrEqual(5000);
    expect(lines[0].d.length).toBeGreaterThan(0);
  });

  it("shrinks size so the widest line fits the max width", () => {
    const linesIn = ["CHAMPIONSHIP NIGHT", "VS"];
    const { fontSize, lines } = fitHeadlineBlock(font, linesIn, 600, 200, 20);
    expect(fontSize).toBeLessThan(200);
    const widest = Math.max(...lines.map((l) => l.width));
    expect(widest).toBeLessThanOrEqual(600);
  });

  it("never goes below the minimum font size", () => {
    const { fontSize } = fitHeadlineBlock(font, ["AN EXTREMELY LONG HEADLINE LINE"], 50, 100, 60);
    expect(fontSize).toBe(60);
  });
});

describe("chromaKeyGreen", () => {
  async function greenScreenWithSubject(): Promise<Buffer> {
    // 200x200 pure green field with an L-shaped red subject (two overlapping
    // rectangles) so the trimmed cutout has both opaque and transparent pixels,
    // like a real irregular subject silhouette.
    const armV = await sharp({
      create: { width: 40, height: 100, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 1 } },
    }).png().toBuffer();
    const armH = await sharp({
      create: { width: 100, height: 40, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 1 } },
    }).png().toBuffer();
    return sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 20, g: 255, b: 30, alpha: 1 } },
    })
      .composite([
        { input: armV, left: 50, top: 50 },
        { input: armH, left: 50, top: 110 },
      ])
      .png()
      .toBuffer();
  }

  it("removes the green background and keeps the subject", async () => {
    const input = await greenScreenWithSubject();
    const cutout = await chromaKeyGreen(input);
    // Trimmed to roughly the subject bounds.
    expect(cutout.width).toBeLessThanOrEqual(120);
    expect(cutout.height).toBeLessThanOrEqual(120);

    const { data, info } = await sharp(cutout.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let i = 3; i < data.length; i += info.channels) {
      if (data[i] > 200) opaque++;
    }
    expect(opaque / (info.width * info.height)).toBeGreaterThan(0.5);
  });

  it("quality gate passes a good cutout and rejects an un-keyed frame", async () => {
    const input = await greenScreenWithSubject();
    const cutout = await chromaKeyGreen(input);
    const good = await cutoutQuality(cutout.buffer, 200, 200);
    expect(good.ok).toBe(true);

    const opaqueFrame = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 10, g: 10, b: 200, alpha: 1 } },
    }).png().toBuffer();
    const bad = await cutoutQuality(opaqueFrame, 200, 200);
    expect(bad.ok).toBe(false);
  });
});
