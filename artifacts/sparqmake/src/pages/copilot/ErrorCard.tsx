/**
 * Error card — mapped titles/bodies, Details disclosure, Try again, Dismiss.
 * Spec §Phase C / ErrorCard.tsx
 * Raw server strings NEVER render directly in the thread.
 */
import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";
import type { Turn, RunTurnFn, Region, TurnPayload } from "./types";

interface ErrorCardProps {
  turn: Turn;
  runTurn: RunTurnFn;
  canWrite: boolean;
  turnPayload?: TurnPayload | null;
}

interface ErrorInfo {
  title: string;
  body: string;
}

function classifyError(turn: Turn): ErrorInfo {
  const raw = (turn.error ?? "").toLowerCase();

  // 429 + budget / reservation
  if (raw.includes("429") || raw.includes("budget") || raw.includes("reservation")) {
    if (raw.includes("rate") || raw.includes("limit") || raw.includes("too many")) {
      return {
        title: "Too many generations at once",
        body: "The studio allows 5 generations per minute. Give it a moment and try again.",
      };
    }
    return {
      title: "Budget limit reached",
      body: "This turn would pass the session budget. Try again in a minute or adjust budgets in Settings.",
    };
  }

  // 400 + invalid_request or media type
  if (
    raw.includes("400") ||
    raw.includes("invalid_request") ||
    raw.includes("media type") ||
    raw.includes("image/") ||
    raw.includes("image format")
  ) {
    return {
      title: "The model rejected the image format",
      body: "Something about the current image did not match what the model expects. Try again, it usually clears.",
    };
  }

  // timeout
  if (raw.includes("timeout") || raw.includes("timed out")) {
    return {
      title: "The model took too long",
      body: "The generation timed out. Try again, shorter instructions often help.",
    };
  }

  // 5xx / network / fetch
  if (
    raw.includes("5") ||
    raw.includes("network") ||
    raw.includes("fetch") ||
    raw.includes("connection")
  ) {
    return {
      title: "Connection hiccup",
      body: "The server had a moment. Your session is safe, try again.",
    };
  }

  // default
  return {
    title: "That step did not go through",
    body: "The full error is under Details. Try again usually works.",
  };
}

function reconstructPayload(turn: Turn): {
  action: string;
  instruction: string;
  platform?: string;
  region?: Region;
  assetIds?: string[];
} {
  return {
    action: turn.action,
    instruction: (turn.instruction ?? (turn.metadata?.instruction as string | undefined)) || "",
    platform: turn.metadata?.platform as string | undefined,
    region: turn.metadata?.region as Region | undefined,
    assetIds: turn.metadata?.assetIds as string[] | undefined,
  };
}

export function ErrorCard({ turn, runTurn, canWrite, turnPayload }: ErrorCardProps) {
  const [dismissed, setDismissed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { title, body } = classifyError(turn);
  const raw = turn.error ?? "";

  if (dismissed) {
    return (
      <div className="text-xs text-muted-foreground italic px-1 py-0.5">
        Step did not complete
      </div>
    );
  }

  // A region edit retried without its region is a guaranteed server error —
  // if neither the in-memory payload nor the turn metadata has the region,
  // don't offer a broken retry.
  const reconstructed = reconstructPayload(turn);
  const canRetry =
    turn.action !== "edit_region" ||
    Boolean(turnPayload?.region || reconstructed.region);

  const handleRetry = () => {
    if (turnPayload) {
      void runTurn(
        turnPayload.action,
        turnPayload.instruction,
        turnPayload.platform,
        turnPayload.region,
        undefined,
        turnPayload.sourceVariantId,
        turnPayload.assetIds,
      );
    } else {
      const p = reconstructPayload(turn);
      void runTurn(p.action, p.instruction, p.platform, p.region, undefined, undefined, p.assetIds);
    }
  };

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-destructive">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{body}</p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground shrink-0"
        >
          <X size={12} />
        </button>
      </div>

      {raw && (
        <div>
          <button
            onClick={() => setDetailsOpen(o => !o)}
            className="text-[10px] text-muted-foreground flex items-center gap-1 hover:text-foreground"
          >
            {detailsOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            Details
          </button>
          {detailsOpen && (
            <pre className="mt-1.5 text-[10px] bg-muted/60 rounded px-2 py-1.5 overflow-auto max-h-20 text-muted-foreground font-mono whitespace-pre-wrap break-all">
              {raw}
            </pre>
          )}
        </div>
      )}

      {canWrite && canRetry && (
        <button
          onClick={handleRetry}
          className="flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <RotateCcw size={11} />
          Try again
        </button>
      )}
    </div>
  );
}
