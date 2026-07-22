/**
 * Pure function: next-step suggestion chips for the most recent done copilot turn.
 * Spec §Phase C / suggestions.ts
 */
import type { Turn, Session } from "./types";

export type SuggestionKind = "fill" | "run" | "nav";

export interface SuggestionChip {
  label: string;
  kind: SuggestionKind;
  /**
   * fill -> string to set in the composer
   * run  -> { action, instruction, platform? }
   * nav  -> "home" | "calendar"
   */
  payload:
    | string
    | { action: string; instruction: string; platform?: string }
    | "home"
    | "calendar";
}

export function suggestionsFor(turn: Turn, session: Session | null): SuggestionChip[] {
  if (turn.role !== "copilot" || turn.status !== "done") return [];

  switch (turn.action) {
    case "draft":
      return [
        {
          label: "Make it bolder",
          kind: "fill",
          payload: "/edit make the composition bolder and more energetic",
        },
        {
          label: "3 fresh takes",
          kind: "run",
          payload: { action: "compare", instruction: "Generate 3 fresh takes" },
        },
        {
          label: "Write captions",
          kind: "fill",
          payload: "/caption ",
        },
      ];

    case "edit_image":
    case "edit_region":
      return [
        {
          label: "Push it further",
          kind: "fill",
          payload: "/edit ",
        },
        {
          label: "Compare takes",
          kind: "run",
          payload: { action: "compare", instruction: "Generate 3 fresh takes" },
        },
        {
          label: "Make platform set",
          kind: "run",
          payload: { action: "fan_out", instruction: "Create platform-optimized versions for all channels" },
        },
      ];

    case "compare":
      // No chips while waiting for a take pick; helper text is shown by TurnCard
      return [];

    case "caption":
      return [
        {
          label: "Punchier",
          kind: "run",
          payload: { action: "caption", instruction: "Rewrite the caption to be punchier and more engaging" },
        },
        {
          label: "Make platform set",
          kind: "run",
          payload: { action: "fan_out", instruction: "Create platform-optimized versions for all channels" },
        },
      ];

    case "convert_video":
      return [
        {
          label: "Refine the video",
          kind: "fill",
          payload: "/video ",
        },
        {
          label: "Make platform set",
          kind: "run",
          payload: { action: "fan_out", instruction: "Create platform-optimized versions for all channels" },
        },
      ];

    case "edit_video":
      return [
        {
          label: "Refine again",
          kind: "fill",
          payload: "/video ",
        },
        {
          label: "Make platform set",
          kind: "run",
          payload: { action: "fan_out", instruction: "Create platform-optimized versions for all channels" },
        },
      ];

    case "fan_out":
      // Card owns approve + schedule; no suggestion chips
      return [];

    case "schedule":
      return [
        {
          label: "Open calendar",
          kind: "nav",
          payload: "calendar",
        },
        {
          label: "Start another post",
          kind: "nav",
          payload: "home",
        },
      ];

    default:
      return [];
  }
}
