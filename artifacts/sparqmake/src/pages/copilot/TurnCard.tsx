/**
 * TurnCard — copilot turn card with:
 *   - In-card meta (cost + duration in header)
 *   - 92px thumbnails
 *   - Click-to-branch on image-producing turns (draft, edit_image, edit_region)
 *   - Suggestion chips on the most recent done copilot turn
 *   - ErrorCard for error status
 *   - Pulsing border for running status (no spinner inside)
 *   - "Stopped" for cancelled turns
 * Spec §Phase C
 */
import { Check, Bot, Video, Layers, Calendar, Clock, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Turn, Variant, FanOutPlatformCard, RunTurnFn, Region, TurnPayload } from "./types";
import { ACTION_LABELS } from "./types";
import { FanOutCard } from "./FanOutCard";
import { ErrorCard } from "./ErrorCard";
import { suggestionsFor } from "./suggestions";
import { useLocation } from "wouter";

interface TurnCardProps {
  turn: Turn;
  allVariants: Variant[];
  activeVariantId: string | null;
  isLatestDone: boolean;
  canWrite: boolean;
  runTurn: RunTurnFn;
  turnPayload?: TurnPayload | null;
  prevUserTurn?: Turn | null;
  isRunning: boolean;
  onFillComposer: (text: string) => void;
  onPickTake: (variantId: string) => void;
  onSchedule: (
    schedules: Array<{ variantId: string; platform: string; scheduledAt: string }>,
  ) => void;
  onConvertVideo: (sourceVariantId: string) => void;
  convertedVariants: Record<string, string>;
  onBranchToVariant: (variantId: string) => void;
  onNavigateHome: () => void;
}

const BRANCH_ALLOWED_ACTIONS = new Set(["draft", "edit_image", "edit_region", "compare"]);

function TurnIcon({ action, isVideo, isFanOut, isSchedule }: {
  action: string; isVideo: boolean; isFanOut: boolean; isSchedule: boolean;
}) {
  if (isVideo) return <Video size={14} className="text-primary" />;
  if (isFanOut) return <Layers size={14} className="text-primary" />;
  if (isSchedule) return <Calendar size={14} className="text-primary" />;
  return <Bot size={14} className="text-primary" />;
}

export function TurnCard({
  turn,
  allVariants,
  activeVariantId,
  isLatestDone,
  canWrite,
  runTurn,
  turnPayload,
  prevUserTurn,
  isRunning,
  onFillComposer,
  onPickTake,
  onSchedule,
  onConvertVideo,
  convertedVariants,
  onBranchToVariant,
  onNavigateHome,
}: TurnCardProps) {
  const [, setLocation] = useLocation();
  const isUser = turn.role === "user";
  const isCompare = turn.action === "compare";
  const isFanOut = turn.action === "fan_out";
  const isSchedule = turn.action === "schedule";
  const isVideo = turn.action === "convert_video" || turn.action === "edit_video";
  const variantIds = (turn.resultVariantIds || []) as string[];
  const variantMap = new Map(allVariants.map(v => [v.id, v]));

  const metaPlatforms = turn.metadata?.platforms as FanOutPlatformCard[] | undefined;
  const metaEntryIds = turn.metadata?.entryIds as string[] | undefined;
  const metaRegion = turn.metadata?.region as {
    x0: number; y0: number; x1: number; y1: number;
  } | undefined;
  const metaVideoUrl = turn.metadata?.videoUrl as string | undefined;
  const metaQaRetried = turn.metadata?.qaRetried as boolean | undefined;

  if (isUser) {
    return (
      <div className="flex items-start gap-2 justify-end">
        <div className="bg-primary/10 border border-primary/20 rounded-lg rounded-tr-none px-3 py-2 max-w-[300px]">
          <p className="text-sm">
            {turn.instruction || (
              <span className="italic text-muted-foreground">no instruction</span>
            )}
          </p>
          {metaRegion && (
            <p className="text-[10px] text-primary mt-0.5">
              Region [{(metaRegion.x0 * 100).toFixed(0)}%,{" "}
              {(metaRegion.y0 * 100).toFixed(0)}%] to [
              {(metaRegion.x1 * 100).toFixed(0)}%,{" "}
              {(metaRegion.y1 * 100).toFixed(0)}%]
            </p>
          )}
        </div>
      </div>
    );
  }

  const durationStr =
    turn.durationMs && turn.durationMs > 0
      ? `${(turn.durationMs / 1000).toFixed(1)}s`
      : null;

  const suggestions = isLatestDone ? suggestionsFor(turn, null) : [];

  return (
    <div className="flex items-start gap-2" data-turn-id={turn.id}>
      <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
        <TurnIcon
          action={turn.action}
          isVideo={isVideo}
          isFanOut={isFanOut}
          isSchedule={isSchedule}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            "bg-card border rounded-lg rounded-tl-none p-3 space-y-2 transition-all",
            turn.status === "running"
              ? "border-primary/50 animate-pulse-border"
              : "border-border",
          )}
        >
          {/* Header row — action label + qualifiers + cost + duration */}
          {(turn.status === "done" || turn.status === "running" || turn.status === "cancelled") && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-primary">
                {ACTION_LABELS[turn.action] || turn.action}
              </span>
              {(turn.action === "edit_image" || turn.action === "edit_region") && (
                <span className="text-xs text-muted-foreground">preserving edit</span>
              )}
              {metaQaRetried && (
                <span className="text-xs text-amber-600 dark:text-amber-400">QA corrected</span>
              )}
              <div className="ml-auto flex items-center gap-2 shrink-0">
                {turn.costUsd && turn.costUsd > 0 && (
                  <span className="text-xs text-muted-foreground">
                    ${turn.costUsd.toFixed(4)}
                  </span>
                )}
                {durationStr && turn.status === "done" && (
                  <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                    <Clock size={10} />
                    {durationStr}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Running: just the pulsing border + nothing inside (no spinner) */}

          {/* Cancelled */}
          {turn.status === "cancelled" && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground italic">Stopped</p>
              {canWrite && (
                <button
                  onClick={() => {
                    if (isRunning) return;
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
                      return;
                    }
                    const payload = (prevUserTurn?.instructionPayload ?? {}) as {
                      platform?: string;
                      region?: Region | null;
                      schedules?: Array<{
                        variantId: string; platform: string; scheduledAt: string;
                      }>;
                    };
                    void runTurn(
                      prevUserTurn?.action ?? turn.action,
                      prevUserTurn?.instruction ?? turn.instruction ?? "",
                      payload.platform,
                      payload.region,
                      payload.schedules,
                    );
                  }}
                  disabled={isRunning}
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    isRunning
                      ? "text-muted-foreground cursor-not-allowed"
                      : "text-primary hover:underline",
                  )}
                  data-testid={`button-retry-turn-${turn.id}`}
                >
                  <RotateCcw size={11} />
                  Retry
                </button>
              )}
            </div>
          )}

          {/* Error */}
          {turn.status === "error" && (
            <ErrorCard turn={turn} runTurn={runTurn} canWrite={canWrite} turnPayload={turnPayload} />
          )}

          {/* Done content */}
          {turn.status === "done" && (
            <>
              {isFanOut && metaPlatforms && metaPlatforms.length > 0 ? (
                <FanOutCard
                  platforms={metaPlatforms}
                  onSchedule={onSchedule}
                  onConvertVideo={onConvertVideo}
                  convertedVariants={convertedVariants}
                />
              ) : isSchedule && metaEntryIds ? (
                <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
                  <Check size={12} />
                  {metaEntryIds.length} post{metaEntryIds.length !== 1 ? "s" : ""} added to
                  calendar
                </div>
              ) : isVideo && metaVideoUrl ? (
                <div className="flex items-center gap-2 text-xs text-primary">
                  <Video size={12} />
                  Video ready, preview in the right pane
                </div>
              ) : isCompare && variantIds.length > 1 ? (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-3 gap-1.5">
                    {variantIds.slice(0, 3).map((vid, i) => {
                      const v = variantMap.get(vid);
                      const imgUrl = v?.compositedImageUrl || v?.rawImageUrl;
                      return (
                        <button
                          key={vid}
                          onClick={() => canWrite && onPickTake(vid)}
                          disabled={!canWrite}
                          className={cn(
                            "relative rounded overflow-hidden border-2 border-border transition-all",
                            canWrite ? "hover:border-primary group cursor-pointer" : "cursor-default",
                          )}
                        >
                          {imgUrl ? (
                            <img
                              src={imgUrl}
                              alt={`Take ${i + 1}`}
                              className="w-full aspect-square object-cover"
                            />
                          ) : (
                            <div className="w-full aspect-square bg-muted flex items-center justify-center">
                              <span className="text-xs text-muted-foreground">
                                Take {i + 1}
                              </span>
                            </div>
                          )}
                          {canWrite && (
                            <div className="absolute inset-0 bg-primary/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <Check size={20} className="text-white" />
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {canWrite && (
                    <p className="text-[10px] text-muted-foreground text-center">
                      Pick a take to continue
                    </p>
                  )}
                </div>
              ) : variantIds.length > 0 && !isFanOut ? (
                (() => {
                  const vid = variantIds[0]!;
                  const v = variantMap.get(vid);
                  const imgUrl = v?.compositedImageUrl || v?.rawImageUrl;
                  const isCurrent = vid === activeVariantId;
                  const canBranch = canWrite && BRANCH_ALLOWED_ACTIONS.has(turn.action);
                  return imgUrl ? (
                    <div className="relative">
                      <button
                        onClick={() => canBranch && onBranchToVariant(vid)}
                        disabled={!canBranch}
                        className={cn(
                          "w-[92px] h-[92px] rounded overflow-hidden border-2 transition-all block",
                          canBranch
                            ? isCurrent
                              ? "border-primary"
                              : "border-border hover:border-primary/50 cursor-pointer"
                            : "border-border cursor-default",
                        )}
                        title={canBranch ? "Branch from this version" : undefined}
                      >
                        <img
                          src={imgUrl}
                          alt="Result"
                          className="w-full h-full object-cover"
                        />
                      </button>
                      {isCurrent && (
                        <span className="absolute top-1 left-1 text-[9px] bg-primary text-primary-foreground px-1 py-0.5 rounded font-medium leading-none">
                          current
                        </span>
                      )}
                    </div>
                  ) : null;
                })()
              ) : null}
            </>
          )}
        </div>

        {/* Suggestion chips — only on most recent done copilot turn, hidden for viewers */}
        {isLatestDone && canWrite && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2 ml-1">
            {suggestions.map(chip => (
              <button
                key={chip.label}
                onClick={() => {
                  if (chip.kind === "fill") {
                    onFillComposer(chip.payload as string);
                  } else if (chip.kind === "run") {
                    const p = chip.payload as {
                      action: string;
                      instruction: string;
                      platform?: string;
                    };
                    void runTurn(p.action, p.instruction, p.platform);
                  } else if (chip.kind === "nav") {
                    const dest = chip.payload as "home" | "calendar";
                    if (dest === "home") {
                      onNavigateHome();
                    } else {
                      setLocation("/calendar");
                    }
                  }
                }}
                className="text-[11px] px-2.5 py-1 rounded-full border border-border bg-background hover:bg-muted hover:border-primary/40 transition-colors"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
