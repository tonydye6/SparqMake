import { describe, it, expect } from "vitest";
import { detectLogoIntent, sanitizeLogoInstructions } from "./logo-intent.js";

const logos = [
  { id: "a1", name: "Nitro Wordmark" },
  { id: "a2", name: "Sparq Icon Badge" },
];

describe("detectLogoIntent", () => {
  it("returns no mention for briefs without logo talk", () => {
    const r = detectLogoIntent("A neon city skyline at dusk", logos);
    expect(r.mentioned).toBe(false);
    expect(r.matchedAssetId).toBeNull();
    expect(r.placement).toBeNull();
  });

  it("handles null/empty briefs", () => {
    expect(detectLogoIntent(null, logos).mentioned).toBe(false);
    expect(detectLogoIntent("", logos).mentioned).toBe(false);
  });

  it("matches a named logo and corner placement", () => {
    const r = detectLogoIntent("Epic race shot. Put the Nitro logo in the top right corner.", logos);
    expect(r.mentioned).toBe(true);
    expect(r.matchedAssetId).toBe("a1");
    expect(r.placement).toBe("top_right");
  });

  it("maps 'upper third' to top_right", () => {
    const r = detectLogoIntent("Place the logo in the upper third", logos);
    expect(r.placement).toBe("top_right");
  });

  it("maps lower-left phrasing", () => {
    const r = detectLogoIntent("logo goes bottom-left please", logos);
    expect(r.placement).toBe("bottom_left");
  });

  it("does not match on generic-only mentions", () => {
    const r = detectLogoIntent("Add the primary logo somewhere", logos);
    expect(r.mentioned).toBe(true);
    expect(r.matchedAssetId).toBeNull();
  });

  it("matches the second logo by distinctive token", () => {
    const r = detectLogoIntent("Use the sparq logo bottom right", logos);
    expect(r.matchedAssetId).toBe("a2");
    expect(r.placement).toBe("bottom_right");
  });

  it("takes placement from the logo sentence, not the scene sentence", () => {
    const r = detectLogoIntent(
      "Sunset at the top of the frame is fine.\nNitro logo bottom left.",
      logos,
    );
    expect(r.matchedAssetId).toBe("a1");
    expect(r.placement).toBe("bottom_left");
  });
});

describe("sanitizeLogoInstructions", () => {
  it("leaves logo-free briefs untouched", () => {
    const brief = "A cozy cabin in the snow.";
    expect(sanitizeLogoInstructions(brief)).toBe(brief);
  });

  it("strips logo sentences and appends the no-logo guard", () => {
    const out = sanitizeLogoInstructions("A cozy cabin in the snow. Put the Nitro logo top right.");
    expect(out).toContain("A cozy cabin in the snow.");
    expect(out.toLowerCase()).not.toContain("nitro");
    expect(out).toContain("do not draw any logos");
  });

  it("returns only the guard when the whole brief is a logo instruction", () => {
    const out = sanitizeLogoInstructions("Put the logo bottom left");
    expect(out).toContain("do not draw any logos");
    expect(out.toLowerCase()).not.toContain("bottom left");
  });
});
