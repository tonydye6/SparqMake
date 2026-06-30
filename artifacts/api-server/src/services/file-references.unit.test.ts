import { describe, it, expect } from "vitest";
import { selectSweepable, type SweepCandidate } from "./file-references.js";

const DAY = 24 * 60 * 60 * 1000;

describe("selectSweepable", () => {
  const now = Date.now();
  const cutoff = now - 7 * DAY;

  const referenced = new Set<string>(["generated/keep.png"]);
  const candidates: SweepCandidate[] = [
    { key: "generated/keep.png", namespace: "generated", filename: "keep.png", mtimeMs: now - 30 * DAY },
    { key: "uploads/old.bin", namespace: "uploads", filename: "old.bin", mtimeMs: now - 30 * DAY },
    { key: "uploads/fresh.bin", namespace: "uploads", filename: "fresh.bin", mtimeMs: now - 1 * DAY },
    { key: "generated/bucketonly.png", namespace: "generated", filename: "bucketonly.png" },
  ];

  it("never sweeps a referenced object even when old", () => {
    const out = selectSweepable(candidates, referenced, cutoff, true);
    expect(out.find((c) => c.key === "generated/keep.png")).toBeUndefined();
  });

  it("sweeps aged disk orphans but protects fresh ones (upload→create gap)", () => {
    const out = selectSweepable(candidates, referenced, cutoff, false).map((c) => c.key);
    expect(out).toContain("uploads/old.bin");
    expect(out).not.toContain("uploads/fresh.bin");
  });

  it("excludes undated bucket-only orphans unless opted in", () => {
    const without = selectSweepable(candidates, referenced, cutoff, false).map((c) => c.key);
    expect(without).not.toContain("generated/bucketonly.png");

    const withOptIn = selectSweepable(candidates, referenced, cutoff, true).map((c) => c.key);
    expect(withOptIn).toContain("generated/bucketonly.png");
  });
});
