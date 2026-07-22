/**
 * Session view — two-pane studio (thread + preview).
 *
 * Thread: resizable (360–560 px, default 400 px), collapsible to a 56 px icon
 * rail.  Widths persisted to localStorage ("copilot.threadWidth",
 * "copilot.threadCollapsed").
 *
 * Progress: ONE pinned line between thread and composer, with elapsed counter
 * + Stop button. Running turns show only a pulsing border (no spinner inside).
 */
import {
  useState, useCallback, useEffect, useRef, useReducer,
} from "react";
import { useCanWrite } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import {
  Loader2, ChevronRight, DollarSign, AlertCircle, Bot, Sparkles,
  PanelLeftClose, PanelLeftOpen, Video, Layers, Calendar, Square,
} from "lucide-react";
import { apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import type {
  SessionViewProps, SessionState, Region, AssetItem, BrandAsset, RunTurnFn, Turn, TurnPayload,
} from "./types";
import { sessionReducer, API_BASE } from "./types";
import { StatusBadge } from "./HomeView";
import { TurnCard } from "./TurnCard";
import { Composer } from "./Composer";
import { PreviewPane } from "./PreviewPane";

const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 360;
const MAX_WIDTH = 560;
const COLLAPSED_WIDTH = 56;
const LS_WIDTH = "copilot.threadWidth";
const LS_COLLAPSED = "copilot.threadCollapsed";

function loadWidth(): number {
  try {
    const v = localStorage.getItem(LS_WIDTH);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    }
  } catch {}
  return DEFAULT_WIDTH;
}

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(LS_COLLAPSED) === "true";
  } catch {
    return false;
  }
}

/** Elapsed-second counter; resets on each mount (= each running turn). */
function ProgressLine({ message, onStop }: { message: string; onStop: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="border-t border-primary/20 bg-primary/5 px-3 py-1.5 flex items-center gap-2 text-xs text-primary shrink-0">
      <Loader2 size={11} className="animate-spin shrink-0" />
      <span className="flex-1 truncate">{message}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{elapsed}s</span>
      <button
        onClick={onStop}
        className="shrink-0 text-destructive hover:text-destructive/80 transition-colors"
        title="Stop generation"
      >
        <Square size={11} />
      </button>
    </div>
  );
}

function turnIcon(turn: Turn) {
  const a = turn.action;
  if (a === "convert_video" || a === "edit_video")
    return <Video size={14} className="text-primary" />;
  if (a === "fan_out") return <Layers size={14} className="text-primary" />;
  if (a === "schedule") return <Calendar size={14} className="text-primary" />;
  return <Bot size={14} className="text-primary" />;
}

export function SessionView({ sessionId, onBack, autoDraftBrief }: SessionViewProps) {
  const { toast } = useToast();
  const canWrite = useCanWrite();
  const [, setLocation] = useLocation();

  const [state, dispatch] = useReducer(sessionReducer, {
    session: null,
    turns: [],
    activeVariant: null,
    allVariants: [],
    historyVariants: [],
    loading: true,
    running: false,
    composerText: "",
    progressMessages: [],
    error: null,
    captionAlternates: null,
    captionPlatform: null,
    fanOutVideoVariants: {},
  } satisfies SessionState);

  const threadRef = useRef<HTMLDivElement>(null);
  const turnAbortRef = useRef<AbortController | null>(null);
  const autoDraftFiredRef = useRef(false);
  const inFlightPayloadRef = useRef<TurnPayload | null>(null);
  const turnPayloadsRef = useRef(new Map<string, TurnPayload>());

  // Thread width / collapsed state.  widthRef mirrors threadWidth so drag
  // handlers always read the current width without stale-closure lag; it is
  // seeded from the same state value to guarantee they can never diverge.
  const [threadWidth, setThreadWidth] = useState(loadWidth);
  const widthRef = useRef(threadWidth);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(DEFAULT_WIDTH);

  // Region state (owned here, UI lives in PreviewPane)
  const [regionMode, setRegionMode] = useState(false);
  const [pendingRegion, setPendingRegion] = useState<Region | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);

  // Asset picker state
  const [attachedAssets, setAttachedAssets] = useState<AssetItem[]>([]);
  const [brandAssets, setBrandAssets] = useState<BrandAsset[] | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(false);

  const persistWidth = useCallback((w: number) => {
    widthRef.current = w;
    setThreadWidth(w);
    try { localStorage.setItem(LS_WIDTH, String(w)); } catch {}
  }, []);

  const expandThread = useCallback(() => {
    setCollapsed(false);
    try { localStorage.setItem(LS_COLLAPSED, "false"); } catch {}
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(c => {
      const next = !c;
      try { localStorage.setItem(LS_COLLAPSED, String(next)); } catch {}
      return next;
    });
  }, []);

  // Scroll the thread to a specific turn (expand first if collapsed)
  const scrollToTurn = useCallback((turnId: string) => {
    expandThread();
    setTimeout(() => {
      document
        .querySelector(`[data-turn-id="${turnId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 150);
  }, [expandThread]);

  // Resize handle drag — uses ref to avoid stale closure
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    resizeStartXRef.current = e.clientX;
    resizeStartWidthRef.current = widthRef.current;

    const onMove = (mv: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = mv.clientX - resizeStartXRef.current;
      const next = Math.max(
        MIN_WIDTH, Math.min(MAX_WIDTH, resizeStartWidthRef.current + delta),
      );
      persistWidth(next);
    };
    const onUp = () => {
      isResizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [persistWidth]);

  const loadSession = useCallback(async (): Promise<Turn[]> => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/sessions/${sessionId}`);
      if (!resp.ok) throw new Error("Session not found");
      const data = await resp.json() as {
        session: import("./types").Session;
        turns: import("./types").Turn[];
      };
      const { session, turns } = data;

      const variantIds = [
        ...new Set(turns.flatMap(t => (t.resultVariantIds || []) as string[])),
      ];
      let variants: import("./types").Variant[] = [];
      if (variantIds.length > 0) {
        const vResp = await apiFetch(
          `${API_BASE}/api/creatives/${session.creativeId}/variants`,
        );
        if (vResp.ok) {
          const vData = await vResp.json() as
            | import("./types").Variant[]
            | { variants?: import("./types").Variant[]; data?: import("./types").Variant[] };
          variants = Array.isArray(vData) ? vData : (vData.variants || vData.data || []);
        }
      }
      dispatch({ type: "loaded", session, turns, variants });
      return turns;
    } catch (err) {
      dispatch({
        type: "setError",
        error: err instanceof Error ? err.message : "Failed to load session",
      });
      return [];
    }
  }, [sessionId]);

  useEffect(() => { void loadSession(); }, [loadSession]);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [state.turns, state.progressMessages]);

  useEffect(() => {
    return () => { turnAbortRef.current?.abort(); };
  }, []);

  const runTurn: RunTurnFn = useCallback(async (
    action, instruction, platform, region, schedules, sourceVariantId, assetIds,
  ) => {
    if (state.running) return;
    inFlightPayloadRef.current = { action, instruction, platform, region, assetIds, sourceVariantId };
    dispatch({ type: "setRunning", running: true });
    dispatch({ type: "clearProgress" });
    dispatch({ type: "setError", error: null });

    const abortCtrl = new AbortController();
    turnAbortRef.current = abortCtrl;

    try {
      const resp = await apiFetch(`${API_BASE}/api/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortCtrl.signal,
        body: JSON.stringify({
          action,
          instruction,
          platform,
          compareCount: action === "compare" ? 3 : undefined,
          ...(region ? { region } : {}),
          ...(schedules ? { schedules } : {}),
          ...(sourceVariantId ? { sourceVariantId } : {}),
          ...(assetIds && assetIds.length > 0 ? { assetIds } : {}),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No SSE stream");

      const decoder = new TextDecoder();
      let rawBuf = "";
      const eventBuf: string[] = [];

      const flushEvent = (lines: string[]) => {
        const eventType = lines.find(l => l.startsWith("event: "))?.slice(7).trim();
        const dataLine = lines.find(l => l.startsWith("data: "));
        if (!dataLine) return;
        let data: Record<string, unknown>;
        try { data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>; }
        catch { return; }

        if (eventType === "error") {
          throw new Error((data.message as string | undefined) || "Turn failed");
        }
        if (data.message) dispatch({ type: "addProgress", message: data.message as string });
        if (data.alternates) {
          dispatch({
            type: "setCaptionAlternates",
            alternates: data.alternates as Array<{ caption: string; headline: string }>,
            platform: platform || null,
          });
        }
        if (data.sourceVariantId && Array.isArray(data.variantIds) && data.variantIds[0]) {
          dispatch({
            type: "setFanOutVideoVariant",
            sourceId: data.sourceVariantId as string,
            videoId: data.variantIds[0] as string,
          });
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawBuf += decoder.decode(value, { stream: true });
        const lines = rawBuf.split("\n");
        rawBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "") {
            if (eventBuf.length > 0) flushEvent([...eventBuf]);
            eventBuf.length = 0;
          } else {
            eventBuf.push(line);
          }
        }
      }
      if (eventBuf.length > 0) flushEvent(eventBuf);

      await loadSession();
      inFlightPayloadRef.current = null;
      dispatch({ type: "setComposer", text: "" });
    } catch (err) {
      const wasAborted =
        abortCtrl.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      if (wasAborted) {
        await loadSession();
        inFlightPayloadRef.current = null;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: "setError", error: msg });
        toast({ variant: "destructive", title: "Turn failed", description: msg });
        const capturedPayload = inFlightPayloadRef.current;
        inFlightPayloadRef.current = null;
        const freshTurns = await loadSession();
        if (capturedPayload) {
          const errorTurn = freshTurns.find(
            t => t.status === "error" && !turnPayloadsRef.current.has(t.id),
          );
          if (errorTurn) {
            turnPayloadsRef.current.set(errorTurn.id, capturedPayload);
          }
        }
      }
    } finally {
      dispatch({ type: "setRunning", running: false });
    }
  }, [sessionId, state.running, loadSession, toast]);

  const handleSend = useCallback(() => {
    if (!state.composerText.trim() || state.running) return;
    const text = state.composerText.trim();
    const assetIds = attachedAssets.map(a => a.id);
    const hasPrev = state.session?.imageInteractionId;
    void runTurn(
      hasPrev ? "edit_image" : "draft",
      text, undefined, undefined, undefined, undefined, assetIds,
    );
    setAttachedAssets([]);
  }, [state.composerText, state.running, state.session, runTurn, attachedAssets]);

  const handleRegionEdit = useCallback((instruction: string) => {
    if (!instruction.trim() || !pendingRegion) return;
    void runTurn(
      "edit_region", instruction, undefined, pendingRegion,
      undefined, undefined, attachedAssets.map(a => a.id),
    );
    setAttachedAssets([]);
    setPendingRegion(null);
    setRegionMode(false);
  }, [pendingRegion, runTurn, attachedAssets]);

  const handleStop = useCallback(() => { turnAbortRef.current?.abort(); }, []);

  const fillComposer = useCallback((text: string) => {
    dispatch({ type: "setComposer", text });
    setTimeout(() => {
      (document.querySelector("[data-composer-input]") as HTMLTextAreaElement | null)?.focus();
    }, 50);
  }, [dispatch]);

  // /schedule: scroll to newest fan_out turn
  const scrollToFanOut = useCallback(() => {
    const fanOut = [...state.turns]
      .reverse()
      .find(t => t.action === "fan_out" && t.status === "done");
    if (!fanOut) return;
    if (collapsed) expandThread();
    setTimeout(() => {
      document
        .querySelector(`[data-turn-id="${fanOut.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 150);
  }, [state.turns, collapsed, expandThread]);

  const hasFanOutTurn = state.turns.some(
    t => t.action === "fan_out" && t.status === "done",
  );

  // Auto-draft guard
  useEffect(() => {
    if (!autoDraftBrief || autoDraftFiredRef.current) return;
    if (state.loading || !state.session) return;
    if (state.turns.some(t => t.role === "copilot")) { autoDraftFiredRef.current = true; return; }
    if (!canWrite || state.running) return;
    autoDraftFiredRef.current = true;
    dispatch({ type: "setComposer", text: autoDraftBrief });
    void runTurn("draft", autoDraftBrief);
  }, [autoDraftBrief, state.loading, state.session, state.turns, state.running, canWrite, runTurn]);

  // Reset picker on session switch
  useEffect(() => {
    setAttachedAssets([]);
    setBrandAssets(null);
  }, [sessionId]);

  const loadAssets = useCallback(async () => {
    if (brandAssets !== null || !state.session?.brandId) return;
    setAssetsLoading(true);
    try {
      const resp = await apiFetch(
        `${API_BASE}/api/assets?brandId=${state.session.brandId}&limit=100`,
      );
      if (!resp.ok) throw new Error("Failed to load assets");
      const data = await resp.json() as {
        data?: Array<{
          id: string; name: string; type: string;
          thumbnailUrl: string | null; fileUrl: string | null; mimeType: string | null;
        }>;
      };
      const list = (data.data ?? []).filter(
        a => a.fileUrl && (!a.mimeType || a.mimeType.startsWith("image/")),
      );
      setBrandAssets(list);
    } catch {
      setBrandAssets([]);
    } finally {
      setAssetsLoading(false);
    }
  }, [brandAssets, state.session]);

  const pickHistoryVariant = useCallback(async (variantId: string) => {
    if (!state.session) return;
    try {
      await apiFetch(`${API_BASE}/api/sessions/${sessionId}/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId }),
      });
      await loadSession();
    } catch {
      const variant = state.allVariants.find(v => v.id === variantId);
      if (variant) dispatch({ type: "setActiveVariant", variant });
      toast({
        variant: "destructive",
        title: "Could not branch session",
        description: "Preview updated locally but edits will use the latest image.",
      });
    }
  }, [sessionId, state.session, state.allVariants, loadSession, toast]);

  const pickCompareTake = useCallback(async (turnId: string, variantId: string) => {
    if (!state.session) return;
    try {
      await apiFetch(`${API_BASE}/api/sessions/${sessionId}/turns/${turnId}/pick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId }),
      });
      await loadSession();
    } catch {
      toast({ variant: "destructive", title: "Failed to pick take" });
    }
  }, [sessionId, state.session, loadSession, toast]);

  if (state.loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={32} className="animate-spin text-primary" />
      </div>
    );
  }

  if (state.error && !state.session) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <AlertCircle size={40} className="text-destructive" />
        <p className="text-sm text-muted-foreground">{state.error}</p>
        <Button variant="outline" onClick={onBack}>Back to home</Button>
      </div>
    );
  }

  const { session, turns } = state;
  const hasImage = Boolean(session?.imageInteractionId);

  // Find the most recent done copilot turn ID
  const latestDoneId = [...turns]
    .reverse()
    .find(t => t.role === "copilot" && t.status === "done")
    ?.id ?? null;

  // Copilot turns for the collapsed icon rail
  const copilotTurns = turns.filter(t => t.role === "copilot");

  // Latest progress message
  const latestProgress =
    state.progressMessages[state.progressMessages.length - 1] ?? "Generating...";

  const composerProps = {
    session,
    state,
    dispatch,
    canWrite,
    regionMode,
    setRegionMode,
    attachedAssets,
    setAttachedAssets,
    brandAssets,
    assetsLoading,
    onLoadAssets: loadAssets,
    handleSend,
    runTurn,
    onStop: handleStop,
    onScrollToFanOut: scrollToFanOut,
    hasFanOutTurn,
    sessionId,
  };

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="h-12 border-b border-border flex items-center gap-3 px-4 shrink-0">
        <button
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 text-sm"
        >
          <ChevronRight size={14} className="rotate-180" />
          Sessions
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium truncate">
          {session?.sessionTitle || "Untitled"}
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {session && (
            <>
              <StatusBadge status={session.status} />
              <span className="flex items-center gap-1">
                <DollarSign size={12} />${session.totalCostUsd?.toFixed(3) || "0.00"}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Body: [thread rail] + [preview pane] */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Thread + composer */}
        <div
          className="flex flex-col border-r border-border shrink-0 relative transition-all duration-200"
          style={{ width: collapsed ? COLLAPSED_WIDTH : threadWidth }}
        >
          {collapsed ? (
            /* ── Collapsed icon rail ── */
            <div className="flex flex-col items-center pt-3 gap-2 overflow-y-auto">
              <button
                onClick={toggleCollapsed}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                title="Expand thread"
              >
                <PanelLeftOpen size={16} />
              </button>
              <div className="w-px h-3 bg-border shrink-0" />
              {copilotTurns.map(t => (
                <button
                  key={t.id}
                  onClick={() => scrollToTurn(t.id)}
                  title={t.action}
                  className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors shrink-0 ${
                    t.id === latestDoneId
                      ? "bg-primary/15 ring-1 ring-primary/30"
                      : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  {turnIcon(t)}
                </button>
              ))}
            </div>
          ) : (
            <>
              {/* Collapse toggle row */}
              <div className="h-9 flex items-center justify-end px-2 border-b border-border shrink-0">
                <button
                  onClick={toggleCollapsed}
                  className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Collapse thread"
                >
                  <PanelLeftClose size={14} />
                </button>
              </div>

              {/* Turn list */}
              <div ref={threadRef} className="flex-1 overflow-auto p-4 space-y-3">
                {turns.length === 0 && !state.running && (
                  <div className="text-center py-12">
                    <Bot size={32} className="mx-auto text-muted-foreground mb-3" />
                    <p className="text-sm text-muted-foreground">Start with a draft below</p>
                    {canWrite && (
                      <Button
                        className="mt-4"
                        size="sm"
                        onClick={() =>
                          void runTurn("draft", session?.sessionTitle || "Draft a post")
                        }
                        disabled={state.running}
                      >
                        <Sparkles size={14} />
                        Draft now
                      </Button>
                    )}
                  </div>
                )}

                {turns.map((turn, idx) => (
                  <TurnCard
                    key={turn.id}
                    turn={turn}
                    allVariants={state.allVariants}
                    activeVariantId={state.activeVariant?.id ?? null}
                    isLatestDone={turn.id === latestDoneId}
                    canWrite={canWrite}
                    runTurn={runTurn}
                    turnPayload={turnPayloadsRef.current.get(turn.id) ?? null}
                    prevUserTurn={
                      turns.slice(0, idx).reverse().find(t => t.role === "user") ?? null
                    }
                    isRunning={state.running}
                    onFillComposer={fillComposer}
                    onPickTake={variantId =>
                      canWrite && void pickCompareTake(turn.id, variantId)
                    }
                    onSchedule={schedules =>
                      canWrite && void runTurn("schedule", "", undefined, undefined, schedules)
                    }
                    onConvertVideo={sourceVariantId =>
                      canWrite &&
                      void runTurn(
                        "convert_video",
                        "Convert this image into a dynamic short video clip with natural movement and ambient animation",
                        "youtube",
                        undefined,
                        undefined,
                        sourceVariantId,
                      )
                    }
                    convertedVariants={state.fanOutVideoVariants}
                    onBranchToVariant={variantId => void pickHistoryVariant(variantId)}
                    onNavigateHome={onBack}
                  />
                ))}
              </div>

              {/* Progress line — pinned between thread and composer */}
              {state.running && (
                <ProgressLine message={latestProgress} onStop={handleStop} />
              )}

              {/* Composer */}
              <Composer {...composerProps} />
            </>
          )}

          {/* Resize handle (expanded only) — double-click resets to 400px */}
          {!collapsed && (
            <div
              onMouseDown={onResizeMouseDown}
              onDoubleClick={() => persistWidth(DEFAULT_WIDTH)}
              className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-primary/20 active:bg-primary/40 transition-colors z-10"
              title="Drag to resize · Double-click to reset"
            />
          )}
        </div>

        {/* Preview pane */}
        <PreviewPane
          state={state}
          dispatch={dispatch}
          hasImage={hasImage}
          canWrite={canWrite}
          regionMode={regionMode}
          setRegionMode={setRegionMode}
          pendingRegion={pendingRegion}
          setPendingRegion={setPendingRegion}
          dragStart={dragStart}
          setDragStart={setDragStart}
          dragCurrent={dragCurrent}
          setDragCurrent={setDragCurrent}
          pickHistoryVariant={pickHistoryVariant}
          runTurn={runTurn}
          handleRegionEdit={handleRegionEdit}
          attachedAssets={attachedAssets}
          onFillComposer={fillComposer}
        />

        {/* Floating composer when thread is collapsed (writers only) */}
        {collapsed && canWrite && (
          <div className="absolute bottom-4 left-[72px] right-4 flex justify-center z-30">
            <div className="w-full max-w-[560px] bg-background border border-border rounded-xl shadow-xl px-3 py-2 flex items-center gap-2">
              <Composer {...composerProps} compact />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
