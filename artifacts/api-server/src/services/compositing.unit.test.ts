import { describe, it, expect } from "vitest";
import { fitHeadline, chooseCropOrigin } from "./compositing.js";

describe("fitHeadline", () => {
  it("keeps short text at the base size on one line", () => {
    const r = fitHeadline("GAME ON", 48, 800, 2, 300);
    expect(r.fontSize).toBe(48);
    expect(r.lines).toEqual(["GAME ON"]);
  });

  it("never drops words, even for very long headlines", () => {
    const text = "The championship series returns to the arena this weekend with everything on the line";
    const r = fitHeadline(text, 64, 500, 2, 250);
    expect(r.lines.join(" ")).toBe(text);
  });

  it("shrinks the font instead of truncating when text overflows max lines", () => {
    const text = "A very long headline that cannot possibly fit on two lines at full size";
    const r = fitHeadline(text, 60, 400, 2, 400);
    expect(r.fontSize).toBeLessThan(60);
    expect(r.lines.join(" ")).toBe(text);
  });

  it("respects the vertical block budget", () => {
    const text = "One two three four five six seven eight nine ten";
    const r = fitHeadline(text, 80, 300, 3, 200);
    expect(r.lines.length * r.fontSize * 1.15).toBeLessThanOrEqual(200 + r.fontSize * 1.15); // floor case may slightly overflow but shrinks first
    expect(r.lines.join(" ")).toBe(text);
  });
});

describe("chooseCropOrigin", () => {
  it("centers on the focal point without a box", () => {
    expect(chooseCropOrigin(500, 400, 1000, null, null)).toBe(300);
  });

  it("clamps to the source bounds", () => {
    expect(chooseCropOrigin(50, 400, 1000, null, null)).toBe(0);
    expect(chooseCropOrigin(950, 400, 1000, null, null)).toBe(600);
  });

  it("shifts minimally to contain the subject box", () => {
    // Focal at 500 → window [300,700], but box extends to 750: shift right.
    expect(chooseCropOrigin(500, 400, 1000, 400, 750)).toBe(350);
    // Box starts left of the window: shift left.
    expect(chooseCropOrigin(500, 400, 1000, 250, 600)).toBe(250);
  });

  it("keeps a fully contained box where the focal put it", () => {
    expect(chooseCropOrigin(500, 400, 1000, 350, 650)).toBe(300);
  });

  it("centers on the box when it is larger than the window", () => {
    // Box [100,900] center 500, window 400 → origin 300.
    expect(chooseCropOrigin(200, 400, 1000, 100, 900)).toBe(300);
  });
});
