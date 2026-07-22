/**
 * Live verification of two Interactions API capabilities the Co-pilot Studio
 * gates behind flags. Run ON REPLIT (needs the live GEMINI_API_KEY):
 *
 *   cd artifacts/api-server && pnpm exec tsx scripts/verify-interactions-capabilities.ts
 *
 * Probes (costs roughly two image generations, ~$0.12):
 *   1. Baseline: one untyped inline reference image (the shipped request shape).
 *   2. Typed reference roles: the same request with `reference_type` on the
 *      image block ("character" | "object" | "style"). If accepted, set
 *      INTERACTIONS_TYPED_REFS=on in the environment to enable typed slots
 *      and the 10-reference budget in interactions-client.ts.
 *   3. Abort support: whether ai.interactions.create rejects promptly when an
 *      AbortSignal is supplied via request options (real HTTP cancellation).
 *
 * Writes findings to docs/INTERACTIONS_CAPABILITIES.md (repo-relative) and
 * prints them to stdout. Honest by design: a failed probe is reported as
 * unsupported, never retried into a false positive.
 */

import { ai } from "@workspace/integrations-gemini-ai";
import { COPILOT_MODELS } from "../src/lib/ai-config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 1x1 gold PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

interface ProbeResult {
  name: string;
  supported: boolean;
  detail: string;
}

async function probeBaseline(): Promise<ProbeResult> {
  try {
    const resp = await ai.interactions.create({
      model: COPILOT_MODELS.NANO_BANANA_MODEL,
      input: [
        { type: "text", text: "A plain gold square on a navy background. Reference images provided: [Image 1: Object reference — a gold pixel]" },
        { type: "image", data: TINY_PNG_BASE64, mime_type: "image/png" },
      ],
      response_format: { type: "image", aspect_ratio: "1:1" },
    } as Parameters<typeof ai.interactions.create>[0]) as { id?: string; output_image?: { data?: string } };
    const ok = Boolean(resp.output_image?.data && resp.id);
    return { name: "Baseline untyped inline reference", supported: ok, detail: ok ? `interaction id ${resp.id}` : "no image data returned" };
  } catch (err) {
    return { name: "Baseline untyped inline reference", supported: false, detail: String(err) };
  }
}

async function probeTypedRefs(): Promise<ProbeResult> {
  try {
    const resp = await ai.interactions.create({
      model: COPILOT_MODELS.NANO_BANANA_MODEL,
      input: [
        { type: "text", text: "A plain gold square on a navy background." },
        { type: "image", data: TINY_PNG_BASE64, mime_type: "image/png", reference_type: "object" },
      ],
      response_format: { type: "image", aspect_ratio: "1:1" },
    } as Parameters<typeof ai.interactions.create>[0]) as { id?: string; output_image?: { data?: string } };
    const ok = Boolean(resp.output_image?.data && resp.id);
    return {
      name: "Typed reference roles (reference_type on image blocks)",
      supported: ok,
      detail: ok
        ? "request accepted with reference_type field — set INTERACTIONS_TYPED_REFS=on"
        : "request accepted but returned no image; leave INTERACTIONS_TYPED_REFS off",
    };
  } catch (err) {
    return {
      name: "Typed reference roles (reference_type on image blocks)",
      supported: false,
      detail: `rejected: ${String(err).slice(0, 300)} — leave INTERACTIONS_TYPED_REFS off (prose role labels remain in force)`,
    };
  }
}

async function probeAbort(): Promise<ProbeResult> {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 250);
  try {
    // Try passing request options with a signal as a second argument — SDK
    // support varies; a TypeError or ignored signal both mean "unsupported".
    await (ai.interactions.create as unknown as (body: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>)(
      {
        model: COPILOT_MODELS.NANO_BANANA_MODEL,
        input: "A plain gold square on a navy background.",
        response_format: { type: "image", aspect_ratio: "1:1" },
      },
      { signal: controller.signal },
    );
    return { name: "Abort signal on interactions.create", supported: false, detail: "call completed despite abort; signal is ignored" };
  } catch (err) {
    const elapsed = Date.now() - started;
    const looksAborted = /abort/i.test(String(err)) && elapsed < 5_000;
    return {
      name: "Abort signal on interactions.create",
      supported: looksAborted,
      detail: looksAborted
        ? `rejected ${elapsed}ms after abort — real cancellation works; wire fetchOptions.signal in interactions-client.ts`
        : `rejected but not abort-shaped (${elapsed}ms): ${String(err).slice(0, 200)}`,
    };
  }
}

async function main() {
  console.log(`Model under test: ${COPILOT_MODELS.NANO_BANANA_MODEL}`);
  const results: ProbeResult[] = [];
  results.push(await probeBaseline());
  // Only probe typed refs when the baseline works — otherwise the answer is noise.
  results.push(results[0]!.supported ? await probeTypedRefs() : {
    name: "Typed reference roles (reference_type on image blocks)",
    supported: false,
    detail: "skipped: baseline probe failed",
  });
  results.push(await probeAbort());

  const lines = [
    "# Interactions API Capabilities (live-verified)",
    "",
    `Verified: ${new Date().toISOString()} · Model: ${COPILOT_MODELS.NANO_BANANA_MODEL}`,
    "",
    ...results.map(r => `## ${r.name}\n\n**Supported: ${r.supported ? "YES" : "NO"}**\n\n${r.detail}\n`),
    "## Flags",
    "",
    "- `INTERACTIONS_TYPED_REFS=on` enables typed reference roles + the 10-reference budget (interactions-client.ts). Only set it when the typed probe above says YES.",
    "",
  ];
  const md = lines.join("\n");
  console.log("\n" + md);

  const here = dirname(fileURLToPath(import.meta.url));
  const docsDir = join(here, "..", "..", "..", "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "INTERACTIONS_CAPABILITIES.md"), md);
  console.log(`\nWritten to ${join(docsDir, "INTERACTIONS_CAPABILITIES.md")}`);
}

main().catch(err => {
  console.error("Verification script failed outright:", err);
  process.exit(1);
});
