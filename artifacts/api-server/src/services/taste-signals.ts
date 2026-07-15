import { db, tasteSignalsTable } from "@workspace/db";
import { maybeDistillBrandTaste } from "./taste-distillation.js";

export type TasteSignalType =
  | "take_selected"
  | "take_passed_over"
  | "vary"
  | "caption_edit"
  | "headline_edit"
  | "regenerate"
  | "variant_approved"
  | "variant_rejected"
  | "reaction";

export interface TasteSignalInput {
  brandId: string;
  creativeId?: string | null;
  variantId?: string | null;
  signalType: TasteSignalType;
  payload?: Record<string, unknown>;
  userId?: string | null;
}

// Fire-and-forget signal capture. Like recordAudit, this must never throw or
// slow down the primary operation — taste learning is a side channel.
export async function recordTasteSignal(input: TasteSignalInput): Promise<void> {
  try {
    await db.insert(tasteSignalsTable).values({
      brandId: input.brandId,
      creativeId: input.creativeId ?? null,
      variantId: input.variantId ?? null,
      signalType: input.signalType,
      payload: input.payload ?? {},
      userId: input.userId ?? null,
    });
  } catch (err) {
    console.error("Failed to record taste signal:", err instanceof Error ? err.message : err);
    return;
  }

  // Threshold-triggered distillation runs in the background; it handles its
  // own errors and concurrency guard.
  void maybeDistillBrandTaste(input.brandId);
}
