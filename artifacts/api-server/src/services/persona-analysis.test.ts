import { describe, it, expect, vi } from "vitest";

// Mock the Gemini client so importing the service never touches the network.
vi.mock("@workspace/integrations-gemini-ai", () => ({ ai: { models: { generateContent: vi.fn() } } }));

const { parsePersonaFingerprint } = await import("./persona-analysis.js");

describe("parsePersonaFingerprint — AI output → persona fingerprint mapping", () => {
  const full = {
    name: "Neo-Brutalist Editorial",
    description: "Bold blocky layouts.",
    typography: "Heavy grotesk, all caps",
    composition: "Rigid grid, hard crops",
    colorPhilosophy: "Monochrome with acid accents",
    textureAndEffects: "Flat fills, harsh shadows",
    mood: "Confident, rebellious",
  };

  it("maps camelCase fields directly", () => {
    const fp = parsePersonaFingerprint(JSON.stringify(full));
    expect(fp).toEqual(full);
  });

  it("accepts snake_case fallbacks for colorPhilosophy and textureAndEffects", () => {
    const raw = {
      ...full,
      colorPhilosophy: undefined,
      textureAndEffects: undefined,
      color_philosophy: "Muted pastels",
      texture_and_effects: "Soft grain",
    };
    const fp = parsePersonaFingerprint(JSON.stringify(raw));
    expect(fp.colorPhilosophy).toBe("Muted pastels");
    expect(fp.textureAndEffects).toBe("Soft grain");
  });

  it("strips markdown code fences", () => {
    const fp = parsePersonaFingerprint("```json\n" + JSON.stringify(full) + "\n```");
    expect(fp.name).toBe(full.name);
  });

  it("coerces missing/non-string fields to empty strings", () => {
    const fp = parsePersonaFingerprint(JSON.stringify({ name: "X", mood: 42 }));
    expect(fp.name).toBe("X");
    expect(fp.mood).toBe("");
    expect(fp.typography).toBe("");
  });

  it("throws on unparseable output", () => {
    expect(() => parsePersonaFingerprint("not json at all")).toThrow(/Failed to parse/);
  });
});
