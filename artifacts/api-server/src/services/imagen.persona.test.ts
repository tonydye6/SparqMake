import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/integrations-gemini-ai", () => ({ ai: { models: { generateContent: vi.fn() } } }));

const { buildImagePrompt } = await import("./imagen.js");
import type { AssembledContext } from "./context-assembly.js";

function baseCtx(overrides: Partial<AssembledContext> = {}): AssembledContext {
  return {
    brand: { name: "Sparq", imagenPrefix: "BRAND PREFIX." } as AssembledContext["brand"],
    template: {} as AssembledContext["template"],
    primaryAssets: [],
    supportingAssets: [],
    combinedBrief: "",
    hashtagSets: [],
    referenceAnalysis: null,
    generationPacket: null,
    intent: null,
    styleProfile: null,
    designerPersona: null,
    referenceBalance: null,
    ...overrides,
  } as AssembledContext;
}

const persona = {
  id: "p1",
  name: "Neo-Brutalist Editorial",
  typography: "Heavy grotesk",
  composition: "Rigid grid",
  colorPhilosophy: "Acid accents",
  textureAndEffects: "Flat fills",
  mood: "Rebellious",
} as unknown as NonNullable<AssembledContext["designerPersona"]>;

const styleProfile = {
  id: "s1",
  name: "Clean Corporate",
  styleDirection: "Minimal, airy, lots of whitespace",
} as unknown as NonNullable<AssembledContext["styleProfile"]>;

describe("buildImagePrompt — designer persona injection & precedence", () => {
  it("includes the persona fingerprint block when a persona is set", () => {
    const prompt = buildImagePrompt(baseCtx({ designerPersona: persona }));
    expect(prompt).toContain('PRIMARY ART DIRECTION — designed in the style of "Neo-Brutalist Editorial"');
    expect(prompt).toContain("TYPOGRAPHY LANGUAGE: Heavy grotesk");
    expect(prompt).toContain("COMPOSITION: Rigid grid");
    expect(prompt).toContain("COLOR PHILOSOPHY: Acid accents");
    expect(prompt).toContain("TEXTURE & EFFECTS: Flat fills");
    expect(prompt).toContain("MOOD: Rebellious");
  });

  it("omits the persona block when no persona is set", () => {
    const prompt = buildImagePrompt(baseCtx());
    expect(prompt).not.toContain("PRIMARY ART DIRECTION");
    expect(prompt).not.toContain("PRECEDENCE:");
  });

  it("states persona precedence over the design style when both are active", () => {
    const prompt = buildImagePrompt(baseCtx({ designerPersona: persona, styleProfile }));
    expect(prompt).toContain('DESIGN STYLE — "Clean Corporate"');
    expect(prompt).toContain("PRECEDENCE: Where this art direction conflicts with the DESIGN STYLE above, this art direction takes precedence for look and feel.");
    // Persona block must come after the design style block so "above" reads correctly.
    expect(prompt.indexOf("PRIMARY ART DIRECTION")).toBeGreaterThan(prompt.indexOf("DESIGN STYLE"));
  });

  it("omits the precedence line when only a persona is active", () => {
    const prompt = buildImagePrompt(baseCtx({ designerPersona: persona }));
    expect(prompt).not.toContain("PRECEDENCE:");
  });

  it("skips the block entirely when the persona has an empty fingerprint", () => {
    const empty = { ...persona, typography: "", composition: "", colorPhilosophy: "", textureAndEffects: "", mood: "" } as typeof persona;
    const prompt = buildImagePrompt(baseCtx({ designerPersona: empty }));
    expect(prompt).not.toContain("PRIMARY ART DIRECTION");
  });
});
