import { describe, it, expect } from "vitest";
import {
  buildSessionStyleContract,
  wrapEditInstruction,
  slotTypeForAsset,
  slotDescriptionForAsset,
  mergeReferenceSlots,
  parseDirectorOutput,
  buildOverflowDescriptors,
  PERSONA_GUARANTEED_SLOTS,
} from "./creative-direction.js";
import type { ImageSlot } from "./interactions-client.js";
import type { Brand, StyleProfile, DesignerPersona, Asset } from "@workspace/db";

const baseBrand = {
  id: "b1",
  name: "Crown U",
  colorPrimary: "#F5B62E",
  colorSecondary: "#101828",
  colorAccent: "#3B82F6",
  colorBackground: "#0A0A0F",
  characterStyleRules: "Mascots always wear the gold crown.",
  imagenPrefix: "Bold collegiate esports energy.",
  negativePrompt: "gore, gambling imagery",
  tasteGuidance: "The team prefers calm backgrounds.",
} as unknown as Brand;

const emptyBrand = {
  id: "b2",
  name: "Blank Co",
  colorPrimary: "",
  colorSecondary: "",
  colorAccent: "",
  colorBackground: "",
  characterStyleRules: "",
  imagenPrefix: "",
  negativePrompt: "",
  tasteGuidance: "",
} as unknown as Brand;

const profile = {
  id: "sp1",
  name: "Neon Nights",
  styleDirection: "High-contrast neon lighting.",
  colorTreatment: "Duotone navy and gold.",
} as unknown as StyleProfile;

const persona = {
  id: "dp1",
  name: "Ava K",
  typography: "Heavy condensed italics",
  composition: "Diagonal panel structure",
  colorPhilosophy: "Two-tone with one accent",
  textureAndEffects: "Grain and halftone",
  mood: "Triumphant",
} as unknown as DesignerPersona;

function slot(id: string, type: ImageSlot["slot"] = "character"): ImageSlot {
  return { imageBuffer: Buffer.from("x"), mimeType: "image/png", slot: type, assetId: id };
}

describe("buildSessionStyleContract", () => {
  it("composes every configured section in order", () => {
    const contract = buildSessionStyleContract({ brand: baseBrand, styleProfile: profile, persona });
    expect(contract).toContain("Character/style rules: Mascots always wear the gold crown.");
    expect(contract).toContain("Brand colors: primary #F5B62E");
    expect(contract).toContain("Never include: gore, gambling imagery");
    expect(contract).toContain("Brand visual language: Bold collegiate esports energy.");
    expect(contract).toContain('Design style "Neon Nights": High-contrast neon lighting. Color treatment: Duotone navy and gold.');
    expect(contract).toContain('Designer fingerprint ("Ava K")');
    expect(contract).toContain("typography: Heavy condensed italics");
    expect(contract).toContain("Team taste guidance (learned from past approvals/rejections): The team prefers calm backgrounds.");
    expect(contract).toContain('Brand coherence: this image is for "Crown U"');
  });

  it("skips empty fields but always keeps brand coherence", () => {
    const contract = buildSessionStyleContract({ brand: emptyBrand });
    expect(contract).not.toContain("Character/style rules");
    expect(contract).not.toContain("Brand colors");
    expect(contract).not.toContain("Never include");
    expect(contract).toContain('Brand coherence: this image is for "Blank Co"');
  });

  it("handles persona-only and profile-only configurations", () => {
    const personaOnly = buildSessionStyleContract({ brand: emptyBrand, persona });
    expect(personaOnly).toContain("Designer fingerprint");
    expect(personaOnly).not.toContain("Design style");

    const profileOnly = buildSessionStyleContract({ brand: emptyBrand, styleProfile: profile });
    expect(profileOnly).toContain("Design style");
    expect(profileOnly).not.toContain("Designer fingerprint");
  });
});

describe("wrapEditInstruction", () => {
  it("keeps the instruction primary and the contract labeled", () => {
    const wrapped = wrapEditInstruction("CONTRACT TEXT", "make the crown pop");
    expect(wrapped).toContain("STYLE CONTRACT");
    expect(wrapped).toContain("CONTRACT TEXT");
    expect(wrapped).toContain("INSTRUCTION (the user's actual request — it always wins on conflict):\nmake the crown pop");
    expect(wrapped.indexOf("CONTRACT TEXT")).toBeLessThan(wrapped.indexOf("make the crown pop"));
  });

  it("returns the bare instruction when the contract is empty", () => {
    expect(wrapEditInstruction("", "make it bolder")).toBe("make it bolder");
    expect(wrapEditInstruction("   ", "make it bolder")).toBe("make it bolder");
  });
});

describe("slotTypeForAsset", () => {
  it("maps stored classifications to slot types", () => {
    expect(slotTypeForAsset({ assetClass: "compositing", compositingOnly: false })).toBe("object");
    expect(slotTypeForAsset({ assetClass: null, compositingOnly: true })).toBe("object");
    expect(slotTypeForAsset({ assetClass: "subject_reference", compositingOnly: false })).toBe("character");
    expect(slotTypeForAsset({ assetClass: "style_reference", compositingOnly: false })).toBe("style");
    expect(slotTypeForAsset({ assetClass: null, compositingOnly: null })).toBe("object");
  });
});

describe("slotDescriptionForAsset", () => {
  const asset = { name: "Crown U icon", description: "Gold crown mark", characterIdentityNote: "" };
  it("carries the verbatim-fidelity note for object references", () => {
    expect(slotDescriptionForAsset(asset, "object")).toContain("Reproduce this exact asset faithfully");
  });
  it("asks for treatment matching on style references", () => {
    const d = slotDescriptionForAsset(asset, "style");
    expect(d).toContain("Match this asset's visual style");
    expect(d).not.toContain("Reproduce this exact asset");
  });
});

describe("mergeReferenceSlots", () => {
  it("prioritizes attachments, then director, guarantees persona slots, fills with packet", () => {
    const merged = mergeReferenceSlots({
      attached: [slot("a1")],
      director: [slot("d1"), slot("d2")],
      packet: [slot("p1"), slot("p2"), slot("p3")],
      persona: [slot("per1", "style"), slot("per2", "style"), slot("per3", "style")],
      cap: 6,
    });
    const ids = merged.map(s => s.assetId);
    expect(ids).toContain("a1");
    expect(ids).toContain("d1");
    expect(ids).toContain("per1");
    expect(ids).toContain("per2");
    expect(merged.length).toBe(6);
    // attachments always first
    expect(ids[0]).toBe("a1");
  });

  it("never exceeds the cap and drops persona overflow last", () => {
    const merged = mergeReferenceSlots({
      attached: [slot("a1"), slot("a2"), slot("a3")],
      director: [slot("d1"), slot("d2"), slot("d3")],
      packet: [],
      persona: [slot("per1", "style")],
      cap: 4,
    });
    expect(merged.length).toBe(4);
    expect(merged.map(s => s.assetId)).toEqual(["a1", "a2", "a3", "d1"]);
  });

  it("guarantees persona representation when a persona is selected", () => {
    const merged = mergeReferenceSlots({
      attached: [],
      director: [],
      packet: [slot("p1"), slot("p2"), slot("p3"), slot("p4"), slot("p5"), slot("p6")],
      persona: [slot("per1", "style"), slot("per2", "style"), slot("per3", "style")],
      cap: 6,
    });
    const ids = merged.map(s => s.assetId);
    expect(ids.filter(id => id?.startsWith("per")).length).toBe(PERSONA_GUARANTEED_SLOTS);
    expect(ids.filter(id => id?.startsWith("p") && !id.startsWith("per")).length).toBe(4);
  });

  it("dedupes by assetId with first occurrence winning", () => {
    const merged = mergeReferenceSlots({
      attached: [slot("x")],
      director: [slot("x"), slot("y")],
      packet: [slot("y"), slot("z")],
      persona: [],
      cap: 6,
    });
    expect(merged.map(s => s.assetId)).toEqual(["x", "y", "z"]);
  });
});

describe("parseDirectorOutput", () => {
  const valid = new Set(["asset-1", "asset-2"]);

  it("parses structured output and filters invented asset ids", () => {
    const raw = JSON.stringify({
      prompt: "A dramatic arena scene with the gold crown anchoring the top left corner.",
      assetSelections: [
        { assetId: "asset-1", role: "object" },
        { assetId: "made-up", role: "subject" },
      ],
      aspectRatio: "4:5",
    });
    const out = parseDirectorOutput(raw, valid);
    expect(out.usedFallback).toBe(false);
    expect(out.assetSelections).toEqual([{ assetId: "asset-1", role: "object" }]);
    expect(out.aspectRatio).toBe("4:5");
  });

  it("falls back to prose-only on unparseable output", () => {
    const out = parseDirectorOutput("A moody, cinematic scene with heavy grain and gold light.", valid);
    expect(out.usedFallback).toBe(true);
    expect(out.prompt).toContain("moody, cinematic");
    expect(out.assetSelections).toEqual([]);
    expect(out.aspectRatio).toBe("1:1");
  });

  it("falls back when required fields are missing or invalid", () => {
    const out = parseDirectorOutput(JSON.stringify({ assetSelections: [] }), valid);
    expect(out.usedFallback).toBe(true);
    const badRatio = parseDirectorOutput(
      JSON.stringify({ prompt: "A long enough prompt for the schema to accept.", aspectRatio: "2:3" }),
      valid,
    );
    expect(badRatio.usedFallback).toBe(true);
  });
});

describe("buildOverflowDescriptors", () => {
  it("renders descriptor lines for assets with text metadata", () => {
    const assets = [
      { name: "Arena crowd", description: "Night crowd shot", styleNotes: "cool tones", depictedEntities: ["crowd"], colors: ["navy"] },
      { name: "No metadata", description: "", styleNotes: null, depictedEntities: [], colors: [] },
    ] as unknown as Asset[];
    const block = buildOverflowDescriptors(assets);
    expect(block).toContain("ADDITIONAL BRAND ASSET DESCRIPTORS");
    expect(block).toContain("- Arena crowd: Night crowd shot Depicts: crowd Style: cool tones Colors: navy");
    expect(block).not.toContain("No metadata");
  });

  it("returns empty when nothing has text metadata", () => {
    const assets = [{ name: "Blank", description: "", styleNotes: null, depictedEntities: [], colors: [] }] as unknown as Asset[];
    expect(buildOverflowDescriptors(assets)).toBe("");
  });
});
