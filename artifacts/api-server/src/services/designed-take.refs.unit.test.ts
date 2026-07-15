import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies the core designed-mode guarantee: designer work samples
// (styleReferences) are forwarded into BOTH billable stages — the design-spec
// LLM call and the subject-cutout render — with subject-likeness refs keeping
// priority order for the cutout.

const generateDesignSpecMock = vi.fn();
const generateSubjectCutoutMock = vi.fn();

vi.mock("./design-spec.js", () => ({
  generateDesignSpec: (...args: unknown[]) => generateDesignSpecMock(...args),
}));
vi.mock("./subject-cutout.js", () => ({
  generateSubjectCutout: (...args: unknown[]) => generateSubjectCutoutMock(...args),
}));

const { prepareDesignedTake } = await import("./designed-take.js");

const fakeSpec = {
  subject: { prompt: "hero athlete mid-jump" },
};

const subjectRef = { imageBuffer: Buffer.from("subject"), mimeType: "image/png" };
const styleRefA = { imageBuffer: Buffer.from("sampleA"), mimeType: "image/jpeg", description: "work sample A" };
const styleRefB = { imageBuffer: Buffer.from("sampleB"), mimeType: "image/png", description: "work sample B" };

beforeEach(() => {
  generateDesignSpecMock.mockReset().mockResolvedValue({ spec: fakeSpec, usedFallback: false });
  generateSubjectCutoutMock.mockReset().mockResolvedValue({ buffer: Buffer.alloc(4), width: 2, height: 2 });
});

describe("prepareDesignedTake reference propagation", () => {
  it("forwards style references to the design-spec stage", async () => {
    await prepareDesignedTake({
      briefText: "big game friday",
      brandColors: { primary: "#101418" },
      subjectReferences: [subjectRef],
      styleReferences: [styleRefA, styleRefB],
      aspectRatio: "1:1",
    });
    expect(generateDesignSpecMock).toHaveBeenCalledTimes(1);
    const specInput = generateDesignSpecMock.mock.calls[0][0] as { styleReferences?: unknown[] };
    expect(specInput.styleReferences).toEqual([styleRefA, styleRefB]);
  });

  it("forwards subject refs first, then style refs, to the cutout stage", async () => {
    await prepareDesignedTake({
      briefText: "big game friday",
      brandColors: { primary: "#101418" },
      subjectReferences: [subjectRef],
      styleReferences: [styleRefA, styleRefB],
      aspectRatio: "1:1",
    });
    expect(generateSubjectCutoutMock).toHaveBeenCalledTimes(1);
    const cutoutInput = generateSubjectCutoutMock.mock.calls[0][0] as {
      prompt: string;
      referenceImages?: unknown[];
    };
    expect(cutoutInput.prompt).toBe(fakeSpec.subject.prompt);
    expect(cutoutInput.referenceImages).toEqual([subjectRef, styleRefA, styleRefB]);
  });

  it("passes style refs to both stages even with no subject refs", async () => {
    await prepareDesignedTake({
      briefText: "big game friday",
      brandColors: { primary: "#101418" },
      styleReferences: [styleRefA],
      aspectRatio: "1:1",
    });
    const specInput = generateDesignSpecMock.mock.calls[0][0] as { styleReferences?: unknown[] };
    expect(specInput.styleReferences).toEqual([styleRefA]);
    const cutoutInput = generateSubjectCutoutMock.mock.calls[0][0] as { referenceImages?: unknown[] };
    expect(cutoutInput.referenceImages).toEqual([styleRefA]);
  });
});
