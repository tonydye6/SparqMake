/**
 * Co-pilot Studio: session-based creative partner at /copilot.
 *
 * Two views:
 *   Home    — start a session (pickers + brief + concept cards) + continue rail
 *   Session — two-pane conversational studio (thread + live preview + history)
 */

import { useState, useCallback, useEffect, useRef, useReducer } from "react";
import { useCanWrite } from "@/hooks/useAuth";
import {
  Sparkles, Bot, ArrowRight, RotateCcw, MessageSquare,
  Loader2, Clock, ChevronRight, Image as ImageIcon, DollarSign,
  Check, History, X, AlertCircle, Send,
  Video, Layers, Calendar, Crop, Play, Paperclip,
} from "lucide-react";
import { useGetBrands, useGetStyleProfiles } from "@workspace/api-client-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDesignerPersonas } from "@/components/DesignersTab";

const API_BASE = import.meta.env.VITE_API_URL || "";

// ---- Types ----------------------------------------------------------------

interface Concept {
  id: string;
  title: string;
  angle: string;
  intent?: string;
  intentLabel?: string;
}

interface SessionSummary {
  id: string;
  sessionTitle: string | null;
  lastTurnSummary: string | null;
  status: string;
  thumbnailUrl: string | null;
  totalCostUsd: number;
  updatedAt: string;
  brandId: string;
}

interface Turn {
  id: string;
  seq: number;
  role: "user" | "copilot";
  instruction: string | null;
  action: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  resultVariantIds: string[];
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  variantUrls?: string[];
  createdAt: string;
}

interface Session {
  id: string;
  brandId: string;
  creativeId: string;
  status: string;
  activeVariantId: string | null;
  imageInteractionId: string | null;
  videoInteractionId: string | null;
  sessionTitle: string | null;
  lastTurnSummary: string | null;
  thumbnailUrl: string | null;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
}

interface Variant {
  id: string;
  platform: string;
  compositedImageUrl: string | null;
  rawImageUrl: string | null;
  videoUrl?: string | null;
  caption: string;
  headlineText: string | null;
}

interface FanOutPlatformCard {
  platform: string;
  variantId: string;
  imageUrl: string;
  caption: string;
  headline: string;
  suggestedAt: string;
  requiresVideo?: boolean;
}

// ---- Home view -------------------------------------------------------------

interface HomeViewProps {
  onSessionCreated: (sessionId: string, autoDraftBrief?: string) => void;
}

function HomeView({ onSessionCreated }: HomeViewProps) {
  const { toast } = useToast();
  const canWrite = useCanWrite();
  const { data: brands, isLoading: brandsLoading } = useGetBrands();
  const { personas } = useDesignerPersonas();
  const [brandId, setBrandId] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [styleProfileId, setStyleProfileId] = useState<string | null>(null);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [loadingConcepts, setLoadingConcepts] = useState(false);
  const [creating, setCreating] = useState(false);
  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);

  const { data: styleProfiles } = useGetStyleProfiles(brandId ?? "", {
    query: { enabled: Boolean(brandId) } as Parameters<typeof useGetStyleProfiles>[1] extends { query?: infer Q } ? Q : never,
  });

  useEffect(() => {
    if (!brandId && brands && brands.length > 0) {
      setBrandId(brands[0].id);
    }
  }, [brandId, brands]);

  useEffect(() => {
    if (!styleProfileId && styleProfiles?.length) {
      const def = styleProfiles.find(p => p.isDefault);
      if (def) setStyleProfileId(def.id);
    }
  }, [styleProfiles, styleProfileId]);

  const loadConcepts = useCallback(async (bid: string) => {
    setLoadingConcepts(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/concept-suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId: bid, briefText: brief.trim() || undefined }),
      });
      if (!resp.ok) throw new Error("Could not load concepts");
      const data = await resp.json();
      setConcepts(Array.isArray(data.concepts) ? data.concepts : []);
    } catch {
      setConcepts([]);
    } finally {
      setLoadingConcepts(false);
    }
  }, [brief]);

  useEffect(() => {
    if (brandId) void loadConcepts(brandId);
  }, [brandId, loadConcepts]);

  const loadRecentSessions = useCallback(async (bid: string) => {
    setLoadingRecent(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/sessions?brandId=${bid}&limit=6`);
      if (!resp.ok) return;
      const data = await resp.json();
      setRecentSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch {
      setRecentSessions([]);
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  useEffect(() => {
    if (brandId) void loadRecentSessions(brandId);
  }, [brandId, loadRecentSessions]);

  const startSession = useCallback(async (concept?: Concept) => {
    if (!brandId) return;
    const briefText = concept?.angle || brief.trim();
    if (!briefText) {
      toast({ variant: "destructive", title: "Brief required", description: "Enter a brief or pick a concept card." });
      return;
    }
    setCreating(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandId,
          briefText,
          conceptId: concept?.id,
          intent: concept?.intent,
          styleProfileId: styleProfileId || undefined,
          personaId: personaId || undefined,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || "Failed to start session");
      }
      const session = await resp.json() as Session;
      // Picking a concept auto-applies its angle to the session composer and
      // kicks off the first image draft immediately (no extra click needed).
      onSessionCreated(session.id, concept ? briefText : undefined);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not start session",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setCreating(false);
    }
  }, [brandId, brief, styleProfileId, personaId, toast, onSessionCreated]);

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex-1 max-w-4xl mx-auto w-full px-6 py-8 space-y-8">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Bot size={22} className="text-primary" />
            <h1 className="text-2xl font-bold font-display">Co-pilot Studio</h1>
            <Badge variant="outline" className="text-xs">beta</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Image-aware captions, preserving edits, branching history. Every turn shows the model what it did.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Brand</label>
            {brandsLoading ? <Skeleton className="h-9 w-full" /> : (
              <Select value={brandId || ""} onValueChange={setBrandId}>
                <SelectTrigger><SelectValue placeholder="Select brand" /></SelectTrigger>
                <SelectContent>
                  {(brands || []).map(b => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Style Profile</label>
            <Select value={styleProfileId || "none"} onValueChange={v => setStyleProfileId(v === "none" ? null : v)}>
              <SelectTrigger><SelectValue placeholder="No style" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No style</SelectItem>
                {(styleProfiles || []).map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.name}{p.isDefault ? " (default)" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Designer Persona</label>
            <Select value={personaId || "none"} onValueChange={v => setPersonaId(v === "none" ? null : v)}>
              <SelectTrigger><SelectValue placeholder="No persona" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No persona</SelectItem>
                {personas.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {canWrite ? (
          <>
            <div className="space-y-3">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Brief</label>
              <div className="flex gap-2">
                <Textarea
                  value={brief}
                  onChange={e => setBrief(e.target.value)}
                  placeholder="Week 3 rivalry vs Ironclad U, playful trash talk..."
                  rows={3}
                  className="resize-none flex-1"
                  onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void startSession(); }}
                />
                <Button
                  disabled={creating || !brandId}
                  onClick={() => void startSession()}
                  className="self-end"
                >
                  {creating ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  Start
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Or pick a concept</label>
                {brandId && (
                  <button
                    onClick={() => void loadConcepts(brandId)}
                    disabled={loadingConcepts}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    <RotateCcw size={12} className={loadingConcepts ? "animate-spin" : ""} />
                    Refresh
                  </button>
                )}
              </div>

              {loadingConcepts ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[0, 1, 2].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {concepts.map(c => (
                    <button
                      key={c.id}
                      onClick={() => void startSession(c)}
                      disabled={creating || !brandId}
                      className="text-left p-4 border border-border rounded-lg hover:border-primary/60 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="text-sm font-medium mb-1 group-hover:text-primary transition-colors">{c.title}</div>
                      <div className="text-xs text-muted-foreground line-clamp-2">{c.angle}</div>
                      {c.intentLabel && (
                        <Badge variant="secondary" className="mt-2 text-xs">{c.intentLabel}</Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-5 text-sm text-muted-foreground">
            You have view-only access to this brand. Contact an editor or admin to start new Co-pilot sessions.
          </div>
        )}

        {(recentSessions.length > 0 || loadingRecent) && (
          <div className="space-y-3 border-t border-border pt-8">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Continue a session</label>
            {loadingRecent ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[0, 1, 2].map(i => <Skeleton key={i} className="h-20 rounded-lg" />)}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {recentSessions.map(s => (
                  <button
                    key={s.id}
                    onClick={() => onSessionCreated(s.id)}
                    className="text-left flex gap-3 p-3 border border-border rounded-lg hover:border-primary/60 hover:bg-primary/5 transition-colors"
                  >
                    {s.thumbnailUrl ? (
                      <img src={s.thumbnailUrl} alt="" className="w-14 h-14 rounded object-cover shrink-0" />
                    ) : (
                      <div className="w-14 h-14 rounded bg-muted flex items-center justify-center shrink-0">
                        <ImageIcon size={18} className="text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{s.sessionTitle || "Untitled session"}</div>
                      <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{s.lastTurnSummary || "No turns yet"}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <StatusBadge status={s.status} />
                        <span className="text-xs text-muted-foreground">${s.totalCostUsd?.toFixed(3) || "0.00"}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    drafting: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400",
    refining: "bg-blue-500/20 text-blue-700 dark:text-blue-400",
    shipped: "bg-green-500/20 text-green-700 dark:text-green-400",
    archived: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn("text-xs px-1.5 py-0.5 rounded-full font-medium", map[status] || map["drafting"])}>
      {status}
    </span>
  );
}

// ---- Session view ----------------------------------------------------------

type ComposerChip = {
  label: string;
  action: "draft" | "edit_image" | "edit_region" | "caption" | "compare" | "convert_video" | "edit_video" | "fan_out" | "schedule";
  instruction: string;
  requiresImage?: boolean;
  requiresVideo?: boolean;
};

const CHIPS: ComposerChip[] = [
  { label: "Make it bolder", action: "edit_image", instruction: "Make the composition bolder and more energetic", requiresImage: true },
  { label: "New take", action: "compare", instruction: "Generate 3 fresh takes", requiresImage: true },
  { label: "Punchier caption", action: "caption", instruction: "Rewrite all captions to be punchier and more engaging", requiresImage: true },
  { label: "Convert to video", action: "convert_video", instruction: "Convert this image into a dynamic short video clip with natural movement and ambient animation", requiresImage: true },
  { label: "Make platform set", action: "fan_out", instruction: "Create platform-optimized versions for all channels", requiresImage: true },
];

interface SessionViewProps {
  sessionId: string;
  onBack: () => void;
  /** When set (concept pick), pre-fill the composer and auto-start the first draft. */
  autoDraftBrief?: string | null;
}

interface SessionState {
  session: Session | null;
  turns: Turn[];
  activeVariant: Variant | null;
  allVariants: Variant[];
  historyVariants: Array<{ turnSeq: number; variantId: string; thumbnailUrl: string | null }>;
  loading: boolean;
  running: boolean;
  composerText: string;
  progressMessages: string[];
  error: string | null;
  captionAlternates: Array<{ caption: string; headline: string }> | null;
  captionPlatform: string | null;
  // Maps fan-out YouTube card image variantId → converted video variantId
  fanOutVideoVariants: Record<string, string>;
}

type SessionAction =
  | { type: "loaded"; session: Session; turns: Turn[]; variants: Variant[] }
  | { type: "setComposer"; text: string }
  | { type: "setRunning"; running: boolean }
  | { type: "addProgress"; message: string }
  | { type: "clearProgress" }
  | { type: "setError"; error: string | null }
  | { type: "setActiveVariant"; variant: Variant }
  | { type: "addTurn"; turn: Turn }
  | { type: "setCaptionAlternates"; alternates: Array<{ caption: string; headline: string }> | null; platform: string | null }
  | { type: "setFanOutVideoVariant"; sourceId: string; videoId: string };

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "loaded": {
      const activeId = action.session.activeVariantId;
      const active = action.variants.find(v => v.id === activeId) || action.variants[0] || null;
      const historyVariants = buildHistory(action.turns, action.variants);
      return { ...state, session: action.session, turns: action.turns, allVariants: action.variants, activeVariant: active, historyVariants, loading: false };
    }
    case "setComposer": return { ...state, composerText: action.text };
    case "setRunning": return { ...state, running: action.running };
    case "addProgress": return { ...state, progressMessages: [...state.progressMessages.slice(-4), action.message] };
    case "clearProgress": return { ...state, progressMessages: [] };
    case "setError": return { ...state, error: action.error };
    case "setActiveVariant": return { ...state, activeVariant: action.variant };
    case "addTurn": return { ...state, turns: [...state.turns, action.turn] };
    case "setCaptionAlternates": return { ...state, captionAlternates: action.alternates, captionPlatform: action.platform };
    case "setFanOutVideoVariant": return {
      ...state,
      fanOutVideoVariants: { ...state.fanOutVideoVariants, [action.sourceId]: action.videoId },
    };
    default: return state;
  }
}

function buildHistory(turns: Turn[], variants: Variant[]) {
  const variantMap = new Map(variants.map(v => [v.id, v]));
  return turns
    .filter(t => t.role === "copilot" && t.status === "done" && t.resultVariantIds?.length > 0)
    .map(t => {
      const vid = t.resultVariantIds[0];
      const v = variantMap.get(vid);
      return { turnSeq: t.seq, variantId: vid, thumbnailUrl: v?.compositedImageUrl || v?.rawImageUrl || null };
    });
}

const ACTION_LABELS: Record<string, string> = {
  draft: "Draft",
  edit_image: "Targeted edit",
  edit_region: "Region edit",
  caption: "Caption rewrite",
  compare: "Compare takes",
  convert_video: "Convert to video",
  edit_video: "Edit video",
  fan_out: "Platform set",
  schedule: "Scheduled",
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram_feed: "IG Feed",
  instagram_story: "IG Story",
  twitter: "Twitter",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
};

const PLATFORM_OPTIONS = [
  { value: "all", label: "All" },
  { value: "instagram_feed", label: "IG Feed" },
  { value: "instagram_story", label: "IG Story" },
  { value: "twitter", label: "Twitter" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "tiktok", label: "TikTok" },
  { value: "youtube", label: "YouTube" },
] as const;

function SessionView({ sessionId, onBack, autoDraftBrief }: SessionViewProps) {
  const { toast } = useToast();
  // E2: Viewers (role = "viewer") may browse sessions but cannot submit turns.
  const canWrite = useCanWrite();
  // Platform target for caption turns — "all" means rewrite every platform
  const [captionTargetPlatform, setCaptionTargetPlatform] = useState<string>("all");
  // Region selection state
  const [regionMode, setRegionMode] = useState(false);
  const [pendingRegion, setPendingRegion] = useState<{x0:number;y0:number;x1:number;y1:number} | null>(null);
  const [regionInstruction, setRegionInstruction] = useState("");
  const [dragStart, setDragStart] = useState<{x:number;y:number} | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{x:number;y:number} | null>(null);
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
  });

  const threadRef = useRef<HTMLDivElement>(null);

  const loadSession = useCallback(async () => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/sessions/${sessionId}`);
      if (!resp.ok) throw new Error("Session not found");
      const data = await resp.json() as { session: Session; turns: Turn[] };
      const { session, turns } = data;

      const activeId = session.activeVariantId;
      const variantIds = [...new Set(turns.flatMap(t => (t.resultVariantIds || []) as string[]))];
      let variants: Variant[] = [];
      if (variantIds.length > 0) {
        const vResp = await apiFetch(`${API_BASE}/api/creatives/${session.creativeId}/variants`);
        if (vResp.ok) {
          // A1: Endpoint returns a bare array, not a wrapper object.
          const vData = await vResp.json() as Variant[] | { variants?: Variant[]; data?: Variant[] };
          variants = Array.isArray(vData) ? vData : (vData.variants || vData.data || []);
        }
      }

      dispatch({ type: "loaded", session, turns, variants });
    } catch (err) {
      dispatch({ type: "setError", error: err instanceof Error ? err.message : "Failed to load session" });
    }
  }, [sessionId]);

  useEffect(() => { void loadSession(); }, [loadSession]);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [state.turns, state.progressMessages]);

  // D1: Track the in-flight AbortController so we can cancel the SSE fetch on
  // component unmount or when the user navigates Back during an active turn.
  const turnAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      // On unmount, abort any in-flight turn fetch so the server also aborts
      // its in-flight model call (via the req 'close' handler in sessions.ts).
      turnAbortRef.current?.abort();
    };
  }, []);

  const runTurn = useCallback(async (
    action: string,
    instruction: string,
    platform?: string,
    region?: {x0:number;y0:number;x1:number;y1:number} | null,
    schedules?: Array<{variantId:string;platform:string;scheduledAt:string}>,
    sourceVariantId?: string,
    assetIds?: string[],
  ) => {
    if (state.running) return;
    dispatch({ type: "setRunning", running: true });
    dispatch({ type: "clearProgress" });
    dispatch({ type: "setError", error: null });

    // D1: Create a per-turn AbortController so this specific fetch can be
    // cancelled on unmount or back-navigation.
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
      // D3: Proper SSE event-frame parser — accumulates until blank line so
      // event+data pairs spanning chunk boundaries are never mis-parsed.
      // `eventBuf` collects lines in the current frame; a blank line flushes it.
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
        // When a convert_video turn was triggered from a fan-out YouTube card,
        // the result carries sourceVariantId + the new video variantIds[0].
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
            // Blank line = end of event frame; flush accumulated lines
            if (eventBuf.length > 0) flushEvent([...eventBuf]);
            eventBuf.length = 0;
          } else {
            eventBuf.push(line);
          }
        }
      }
      // Flush any trailing frame (stream closed without trailing blank line)
      if (eventBuf.length > 0) flushEvent(eventBuf);

      await loadSession();
      dispatch({ type: "setComposer", text: "" });
    } catch (err) {
      // An aborted fetch (unmount / back-navigation) is not a failure — just
      // stop the spinner quietly, no error toast.
      const wasAborted =
        abortCtrl.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      if (!wasAborted) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: "setError", error: msg });
        toast({ variant: "destructive", title: "Turn failed", description: msg });
      }
    } finally {
      dispatch({ type: "setRunning", running: false });
    }
  }, [sessionId, state.running, loadSession, toast]);

  const handleDraft = useCallback(() => {
    if (!state.composerText.trim()) return;
    void runTurn("draft", state.composerText);
  }, [state.composerText, runTurn]);

  // Auto-start the first draft when the session was created from a concept
  // pick: the concept's angle is applied to the composer and generation kicks
  // off immediately. One-shot guard so failures/reloads never re-trigger it.
  const autoDraftFiredRef = useRef(false);
  useEffect(() => {
    if (!autoDraftBrief || autoDraftFiredRef.current) return;
    if (state.loading || !state.session) return;
    // Only auto-draft brand-new sessions (no copilot turns yet).
    if (state.turns.some(t => t.role === "copilot")) { autoDraftFiredRef.current = true; return; }
    if (!canWrite || state.running) return;
    autoDraftFiredRef.current = true;
    dispatch({ type: "setComposer", text: autoDraftBrief });
    void runTurn("draft", autoDraftBrief);
  }, [autoDraftBrief, state.loading, state.session, state.turns, state.running, canWrite, runTurn]);

  // A4: Removed keyword-regex routing — caption intent is too easy to false-positive
  // on ordinary edit instructions ("make the text cleaner", "shorter headline").
  // Users have explicit caption chips + platform selector for caption-only turns;
  // the composer defaults to edit_image when an image interaction exists.
  // Attach-asset picker: real Asset Library images the user explicitly attaches
  // to their next instruction, so the model uses the actual file (e.g. the real
  // Crown U logo) instead of inventing one.
  const [attachedAssets, setAttachedAssets] = useState<Array<{ id: string; name: string; thumbnailUrl: string | null }>>([]);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [brandAssets, setBrandAssets] = useState<Array<{ id: string; name: string; type: string; thumbnailUrl: string | null; fileUrl: string | null }> | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(false);

  // Reset picker state when switching sessions (different session may belong
  // to a different brand — never show stale asset lists or attachments).
  useEffect(() => {
    setAttachedAssets([]);
    setAssetPickerOpen(false);
    setBrandAssets(null);
  }, [sessionId]);

  const openAssetPicker = useCallback(async () => {
    setAssetPickerOpen(o => !o);
    if (brandAssets !== null || !state.session?.brandId) return;
    setAssetsLoading(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/assets?brandId=${state.session.brandId}&limit=100`);
      if (!resp.ok) throw new Error("Failed to load assets");
      const data = await resp.json() as { data?: Array<{ id: string; name: string; type: string; thumbnailUrl: string | null; fileUrl: string | null; mimeType: string | null }> };
      const list = (data.data ?? []).filter(a => a.fileUrl && (!a.mimeType || a.mimeType.startsWith("image/")));
      setBrandAssets(list);
    } catch {
      setBrandAssets([]);
    } finally {
      setAssetsLoading(false);
    }
  }, [brandAssets, state.session]);

  const toggleAttachedAsset = useCallback((asset: { id: string; name: string; thumbnailUrl: string | null }) => {
    setAttachedAssets(prev => {
      if (prev.some(a => a.id === asset.id)) return prev.filter(a => a.id !== asset.id);
      if (prev.length >= 3) return prev;
      return [...prev, asset];
    });
  }, []);

  const handleSend = useCallback(() => {
    if (!state.composerText.trim() || state.running) return;
    const text = state.composerText.trim();
    const hasPrev = state.session?.imageInteractionId;
    const assetIds = attachedAssets.map(a => a.id);
    if (!hasPrev) {
      void runTurn("draft", text, undefined, undefined, undefined, undefined, assetIds);
    } else {
      void runTurn("edit_image", text, undefined, undefined, undefined, undefined, assetIds);
    }
    setAttachedAssets([]);
    setAssetPickerOpen(false);
  }, [state.composerText, state.running, state.session, runTurn, attachedAssets]);

  const handleRegionEdit = useCallback(() => {
    if (!regionInstruction.trim() || !pendingRegion) return;
    void runTurn("edit_region", regionInstruction, undefined, pendingRegion, undefined, undefined, attachedAssets.map(a => a.id));
    setAttachedAssets([]);
    setAssetPickerOpen(false);
    setPendingRegion(null);
    setRegionInstruction("");
    setRegionMode(false);
  }, [regionInstruction, pendingRegion, runTurn, attachedAssets]);

  const handleImgMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!regionMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDragStart({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
    setDragCurrent(null);
    e.preventDefault();
  }, [regionMode]);

  const handleImgMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!regionMode || !dragStart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDragCurrent({
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    });
  }, [regionMode, dragStart]);

  const handleImgMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!regionMode || !dragStart || !dragCurrent) { setDragStart(null); return; }
    const region = {
      x0: Math.min(dragStart.x, dragCurrent.x),
      y0: Math.min(dragStart.y, dragCurrent.y),
      x1: Math.max(dragStart.x, dragCurrent.x),
      y1: Math.max(dragStart.y, dragCurrent.y),
    };
    if ((region.x1 - region.x0) > 0.05 && (region.y1 - region.y0) > 0.05) {
      setPendingRegion(region);
      setRegionMode(false);
    }
    setDragStart(null);
    setDragCurrent(null);
    e.preventDefault();
  }, [regionMode, dragStart, dragCurrent]);

  const pickHistoryVariant = useCallback(async (variantId: string) => {
    if (!state.session) return;
    try {
      await apiFetch(`${API_BASE}/api/sessions/${sessionId}/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId }),
      });
      // Reload full session so imageInteractionId is synced for subsequent edits
      await loadSession();
    } catch {
      // Still update the local preview even if the branch call fails (graceful degrade)
      const variant = state.allVariants.find(v => v.id === variantId);
      if (variant) dispatch({ type: "setActiveVariant", variant });
      toast({ variant: "destructive", title: "Could not branch session", description: "Preview updated locally but edits will use the latest image." });
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

  const { session, turns, activeVariant, historyVariants } = state;

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 border-b border-border flex items-center gap-3 px-4 shrink-0">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 text-sm">
          <ChevronRight size={14} className="rotate-180" />
          Sessions
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium truncate">{session?.sessionTitle || "Untitled"}</span>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {session && (
            <>
              <StatusBadge status={session.status} />
              <span className="flex items-center gap-1">
                <DollarSign size={12} />
                ${session.totalCostUsd?.toFixed(3) || "0.00"}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="w-[420px] flex flex-col border-r border-border shrink-0">
          <div ref={threadRef} className="flex-1 overflow-auto p-4 space-y-3">
            {turns.length === 0 && !state.running && (
              <div className="text-center py-12">
                <Bot size={32} className="mx-auto text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">Start with a draft below</p>
                <Button
                  className="mt-4"
                  size="sm"
                  onClick={() => void runTurn("draft", session?.sessionTitle || "Draft a post")}
                  disabled={state.running}
                >
                  <Sparkles size={14} />
                  Draft now
                </Button>
              </div>
            )}

            {turns.map(turn => (
              <TurnCard
                key={turn.id}
                turn={turn}
                allVariants={state.allVariants}
                isActive={session?.activeVariantId !== null}
                onPickTake={(variantId) => canWrite && void pickCompareTake(turn.id, variantId)}
                onSchedule={(schedules) => canWrite && void runTurn("schedule", "", undefined, undefined, schedules)}
                onConvertVideo={(sourceVariantId) => canWrite && void runTurn(
                  "convert_video",
                  "Convert this image into a dynamic short video clip with natural movement and ambient animation",
                  "youtube",
                  undefined,
                  undefined,
                  sourceVariantId,
                )}
                convertedVariants={state.fanOutVideoVariants}
              />
            ))}

            {state.running && (
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 space-y-1">
                {state.progressMessages.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-primary">
                    <Loader2 size={12} className="animate-spin shrink-0" />
                    Generating...
                  </div>
                ) : (
                  state.progressMessages.map((msg, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-primary">
                      <Loader2 size={12} className="animate-spin shrink-0" />
                      {msg}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="border-t border-border p-3 space-y-2">
            {/* E2: Viewers see a read-only notice; all interactive controls are hidden (not just disabled). */}
            {!canWrite ? (
              <div className="text-xs text-muted-foreground bg-muted/50 border border-border rounded px-2.5 py-1.5 flex items-center gap-1.5">
                <AlertCircle size={11} />
                View-only — editors and admins can make changes
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {CHIPS.map(chip => {
                    const disabled = state.running || (chip.requiresImage && !state.session?.imageInteractionId);
                    return (
                      <button
                        key={chip.label}
                        onClick={() => void runTurn(chip.action, chip.instruction)}
                        disabled={disabled}
                        className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-primary/10 hover:border-primary/40 transition-colors disabled:opacity-40"
                      >
                        {chip.action === "convert_video" && <Video size={10} className="inline mr-1" />}
                        {chip.action === "fan_out" && <Layers size={10} className="inline mr-1" />}
                        {chip.label}
                      </button>
                    );
                  })}
                  {state.session?.imageInteractionId && (
                    <button
                      onClick={() => { setRegionMode(m => !m); setPendingRegion(null); }}
                      disabled={state.running}
                      className={cn(
                        "text-xs px-2.5 py-1 rounded-full border transition-colors disabled:opacity-40",
                        regionMode ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-primary/10 hover:border-primary/40",
                      )}
                    >
                      <Crop size={10} className="inline mr-1" />
                      Edit region
                    </button>
                  )}
                  {state.session?.videoInteractionId && (
                    <button
                      onClick={() => void runTurn("edit_video", state.composerText || "Refine the video")}
                      disabled={state.running || !state.session?.videoInteractionId}
                      className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-primary/10 hover:border-primary/40 transition-colors disabled:opacity-40"
                    >
                      <Video size={10} className="inline mr-1" />
                      Edit video
                    </button>
                  )}
                </div>

                {/* Platform selector: shown once a draft exists so caption turns can target one platform */}
                {state.session?.imageInteractionId && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-muted-foreground shrink-0">Caption for:</span>
                    {PLATFORM_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setCaptionTargetPlatform(opt.value)}
                        disabled={state.running}
                        className={cn(
                          "text-xs px-2 py-0.5 rounded-full border transition-colors disabled:opacity-40",
                          captionTargetPlatform === opt.value
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border hover:border-primary/40",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}

                {pendingRegion && (
                  <div className="bg-primary/5 border border-primary/20 rounded-lg px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-primary flex items-center gap-1">
                        <Crop size={11} />
                        Region selected: describe the edit
                      </span>
                      <button onClick={() => { setPendingRegion(null); setRegionInstruction(""); }} className="text-muted-foreground hover:text-foreground">
                        <X size={12} />
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="e.g. add a soft glow, change to sunset sky..."
                        className="flex-1 text-xs border border-border rounded px-2 py-1 bg-background"
                        value={regionInstruction}
                        onChange={e => setRegionInstruction(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") handleRegionEdit(); }}
                        autoFocus
                      />
                      <Button size="sm" onClick={handleRegionEdit} disabled={!regionInstruction.trim() || state.running}>
                        Apply
                      </Button>
                    </div>
                  </div>
                )}

                {regionMode && !pendingRegion && (
                  <div className="text-xs text-primary bg-primary/5 border border-primary/20 rounded px-2 py-1.5 flex items-center gap-1.5">
                    <Crop size={11} />
                    Drag on the image to select a region to edit
                  </div>
                )}

                {assetPickerOpen && (
                  <div className="border border-border rounded-lg p-2 max-h-44 overflow-auto space-y-1 bg-card">
                    <div className="flex items-center justify-between px-1 pb-1">
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Attach library assets (max 3)</span>
                      <button onClick={() => setAssetPickerOpen(false)} className="text-muted-foreground hover:text-foreground"><X size={12} /></button>
                    </div>
                    {assetsLoading && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground px-1 py-2">
                        <Loader2 size={12} className="animate-spin" /> Loading assets...
                      </div>
                    )}
                    {!assetsLoading && brandAssets !== null && brandAssets.length === 0 && (
                      <p className="text-xs text-muted-foreground px-1 py-2">No image assets in this brand's library.</p>
                    )}
                    {!assetsLoading && brandAssets?.map(a => {
                      const selected = attachedAssets.some(s => s.id === a.id);
                      return (
                        <button
                          key={a.id}
                          onClick={() => toggleAttachedAsset(a)}
                          className={cn(
                            "w-full flex items-center gap-2 px-1.5 py-1 rounded text-left text-xs transition-colors",
                            selected ? "bg-primary/10 text-primary" : "hover:bg-muted",
                          )}
                        >
                          {a.thumbnailUrl ? (
                            <img src={`${API_BASE}${a.thumbnailUrl}`} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                          ) : (
                            <div className="w-8 h-8 rounded bg-muted flex items-center justify-center shrink-0"><ImageIcon size={12} /></div>
                          )}
                          <span className="flex-1 truncate">{a.name}</span>
                          <span className="text-muted-foreground shrink-0">{a.type}</span>
                          {selected && <Check size={12} className="shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {attachedAssets.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {attachedAssets.map(a => (
                      <span key={a.id} className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs rounded-full pl-1 pr-1.5 py-0.5">
                        {a.thumbnailUrl
                          ? <img src={`${API_BASE}${a.thumbnailUrl}`} alt="" className="w-4 h-4 rounded-full object-cover" />
                          : <Paperclip size={10} />}
                        {a.name}
                        <button onClick={() => setAttachedAssets(prev => prev.filter(p => p.id !== a.id))} className="hover:text-foreground"><X size={10} /></button>
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button
                    size="icon"
                    variant={assetPickerOpen || attachedAssets.length > 0 ? "secondary" : "ghost"}
                    onClick={() => void openAssetPicker()}
                    disabled={state.running}
                    className="self-end shrink-0"
                    title="Attach an asset from the library"
                  >
                    <Paperclip size={14} />
                  </Button>
                  <Textarea
                    value={state.composerText}
                    onChange={e => dispatch({ type: "setComposer", text: e.target.value })}
                    placeholder={session?.imageInteractionId ? "Calm the background, make the crown pop..." : "Brief a draft to start..."}
                    rows={2}
                    className="resize-none text-sm"
                    disabled={state.running}
                    onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend(); }}
                  />
                  <Button size="icon" onClick={handleSend} disabled={state.running || !state.composerText.trim()} className="self-end">
                    {state.running ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  </Button>
                </div>
              </>
            )}
            {state.error && (
              <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                <AlertCircle size={12} />
                {state.error}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          {/* NOTE: no `items-center` here — with a long caption the column grows
              taller than the viewport, and flexbox centering pushes the overflow
              above the scrollable area (image top becomes unreachable). `my-auto`
              on the child centers it when short but top-aligns when it overflows. */}
          <div className="flex-1 overflow-auto p-6 flex justify-center">
            {activeVariant ? (
              <div className="w-full max-w-sm space-y-4 my-auto">
                <div
                  className={cn(
                    "relative rounded-xl overflow-hidden shadow-lg border border-border bg-card",
                    regionMode && "cursor-crosshair",
                  )}
                  onMouseDown={handleImgMouseDown}
                  onMouseMove={handleImgMouseMove}
                  onMouseUp={handleImgMouseUp}
                  onMouseLeave={() => { if (regionMode) { setDragStart(null); setDragCurrent(null); } }}
                >
                  {activeVariant.videoUrl ? (
                    <video
                      src={`${API_BASE}${activeVariant.videoUrl}`}
                      className="w-full aspect-square object-cover"
                      controls
                      autoPlay
                      loop
                      muted
                      playsInline
                    />
                  ) : (
                    <img
                      src={activeVariant.compositedImageUrl || activeVariant.rawImageUrl || ""}
                      alt="Generated post"
                      className="w-full aspect-square object-cover"
                      draggable={false}
                    />
                  )}
                  {activeVariant.headlineText && !activeVariant.videoUrl && (
                    <div className="absolute inset-0 flex items-end p-4 bg-gradient-to-t from-black/60 to-transparent">
                      <p className="text-white font-bold text-lg leading-tight">{activeVariant.headlineText}</p>
                    </div>
                  )}
                  {/* Region drag selection box */}
                  {regionMode && dragStart && dragCurrent && (
                    <div
                      className="absolute border-2 border-primary bg-primary/20 pointer-events-none"
                      style={{
                        left: `${Math.min(dragStart.x, dragCurrent.x) * 100}%`,
                        top: `${Math.min(dragStart.y, dragCurrent.y) * 100}%`,
                        width: `${Math.abs(dragCurrent.x - dragStart.x) * 100}%`,
                        height: `${Math.abs(dragCurrent.y - dragStart.y) * 100}%`,
                      }}
                    />
                  )}
                  {/* Pending region indicator */}
                  {pendingRegion && (
                    <div
                      className="absolute border-2 border-primary border-dashed bg-primary/10 pointer-events-none"
                      style={{
                        left: `${pendingRegion.x0 * 100}%`,
                        top: `${pendingRegion.y0 * 100}%`,
                        width: `${(pendingRegion.x1 - pendingRegion.x0) * 100}%`,
                        height: `${(pendingRegion.y1 - pendingRegion.y0) * 100}%`,
                      }}
                    />
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <MessageSquare size={12} />
                    Caption
                  </div>
                  <p className="text-sm text-foreground leading-relaxed">{activeVariant.caption}</p>
                </div>

                {state.captionAlternates && state.captionAlternates.length > 0 && (
                  <div className="space-y-2 border border-dashed border-border rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Alternates</span>
                      <button onClick={() => dispatch({ type: "setCaptionAlternates", alternates: null, platform: null })} className="text-muted-foreground hover:text-foreground">
                        <X size={14} />
                      </button>
                    </div>
                    {state.captionAlternates.map((alt, i) => (
                      <div key={i} className="p-2 rounded bg-muted/50 text-sm hover:bg-muted cursor-pointer" onClick={() => {}}>
                        <div className="font-medium text-xs mb-1">{alt.headline}</div>
                        <div className="text-muted-foreground text-xs line-clamp-3">{alt.caption}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-2">
                  {(["Punchier", "Shorter", "Add CTA"] as const).map(tune => (
                    <button
                      key={tune}
                      onClick={() => void runTurn("caption", `${tune}: rewrite the caption`)}
                      disabled={state.running}
                      className="text-xs px-2.5 py-1 rounded-full border border-dashed border-border hover:bg-primary/10 hover:border-primary/40 transition-colors disabled:opacity-40"
                    >
                      {tune}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center">
                <ImageIcon size={48} className="mx-auto text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">Preview appears here after the first draft</p>
              </div>
            )}
          </div>

          {historyVariants.length > 1 && (
            <div className="border-t border-border p-3 shrink-0">
              <div className="flex items-center gap-2 mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <History size={12} />
                History
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {historyVariants.map((h, i) => (
                  <button
                    key={h.variantId}
                    onClick={() => void pickHistoryVariant(h.variantId)}
                    className={cn(
                      "shrink-0 w-14 h-14 rounded-lg border-2 overflow-hidden transition-all",
                      state.activeVariant?.id === h.variantId
                        ? "border-primary"
                        : "border-border hover:border-primary/50",
                    )}
                  >
                    {h.thumbnailUrl ? (
                      <img src={h.thumbnailUrl} alt={`T${i + 1}`} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-muted flex items-center justify-center">
                        <span className="text-xs text-muted-foreground">T{i + 1}</span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FanOutCard({
  platforms,
  onSchedule,
  onConvertVideo,
  convertedVariants = {},
}: {
  platforms: FanOutPlatformCard[];
  onSchedule: (schedules: Array<{variantId:string;platform:string;scheduledAt:string}>) => void;
  onConvertVideo: (sourceVariantId: string) => void;
  convertedVariants?: Record<string, string>;
}) {
  const [convertingIds, setConvertingIds] = useState<Set<string>>(new Set());

  // requiresVideo cards (YouTube) become schedulable once converted —
  // their approval entry is seeded lazily when the video variant ID arrives.
  const [approvals, setApprovals] = useState<Record<string, {approved:boolean;scheduledAt:string}>>(() =>
    Object.fromEntries(
      platforms
        .filter(p => !p.requiresVideo)
        .map(p => [p.variantId, { approved: true, scheduledAt: p.suggestedAt }])
    )
  );

  // When a YouTube card conversion completes, seed its approval entry so it
  // becomes immediately schedulable (approved by default).
  useEffect(() => {
    setApprovals(prev => {
      const next = { ...prev };
      for (const [sourceId, videoId] of Object.entries(convertedVariants)) {
        if (videoId && !next[videoId]) {
          const card = platforms.find(p => p.variantId === sourceId);
          next[videoId] = { approved: true, scheduledAt: card?.suggestedAt ?? new Date().toISOString() };
        }
      }
      return next;
    });
  }, [convertedVariants, platforms]);

  const toggleApprove = (variantId: string) =>
    setApprovals(prev => ({ ...prev, [variantId]: { ...prev[variantId]!, approved: !prev[variantId]?.approved } }));

  const setTime = (variantId: string, val: string) => {
    try {
      setApprovals(prev => ({ ...prev, [variantId]: { ...prev[variantId]!, scheduledAt: new Date(val).toISOString() } }));
    } catch {}
  };

  const handleConvertVideo = (sourceVariantId: string) => {
    setConvertingIds(prev => new Set([...prev, sourceVariantId]));
    onConvertVideo(sourceVariantId);
  };

  // For scheduling: use video variantId when available, else original variantId
  const scheduleVariantId = (p: FanOutPlatformCard) =>
    (p.requiresVideo && convertedVariants[p.variantId]) ? convertedVariants[p.variantId] : p.variantId;

  const approvedPlatforms = platforms.filter(p => {
    const vid = scheduleVariantId(p);
    return approvals[vid]?.approved;
  });

  const handleSchedule = () => {
    const schedules = approvedPlatforms.map(p => {
      const vid = scheduleVariantId(p);
      const a = approvals[vid];
      return {
        variantId: vid,
        platform: p.platform,
        scheduledAt: a?.scheduledAt || p.suggestedAt,
      };
    });
    if (schedules.length > 0) onSchedule(schedules);
  };

  return (
    <div className="space-y-2 mt-1">
      <div className="grid grid-cols-2 gap-1.5">
        {platforms.map(p => {
          const videoId = p.requiresVideo ? convertedVariants[p.variantId] : undefined;
          const isConverted = Boolean(videoId);
          const isConverting = convertingIds.has(p.variantId) && !isConverted;
          const vid = scheduleVariantId(p);
          const a = approvals[vid];
          // C1: Build a local datetime string without UTC→local drift.
          // toISOString() converts to UTC before slicing, which shifts the
          // displayed time in users' non-UTC timezones.
          const dtLocal = a?.scheduledAt
            ? (() => {
                const d = new Date(a.scheduledAt);
                const pad = (n: number) => String(n).padStart(2, "0");
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
              })()
            : "";

          // YouTube card: three states —
          //   1. not converted yet → "Convert to video" button
          //   2. converting → spinner
          //   3. converted → normal approve/schedule card (with video badge)
          if (p.requiresVideo && !isConverted) {
            return (
              <div
                key={p.variantId}
                className="border border-dashed border-border rounded-lg overflow-hidden opacity-90"
              >
                <div className="relative">
                  <img src={`${import.meta.env.VITE_API_URL || ""}${p.imageUrl}`} alt={p.platform} className="w-full aspect-square object-cover" />
                  <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-1.5 p-2">
                    <span className="text-[9px] font-bold bg-black/60 text-white px-1.5 py-0.5 rounded">
                      {PLATFORM_LABELS[p.platform] || p.platform}
                    </span>
                    {isConverting ? (
                      <div className="flex items-center gap-1 text-white/90">
                        <Loader2 size={10} className="animate-spin" />
                        <span className="text-[9px]">Converting…</span>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleConvertVideo(p.variantId)}
                        className="flex items-center gap-1 bg-primary text-primary-foreground rounded px-2 py-0.5 text-[9px] font-semibold hover:bg-primary/90 transition-colors"
                      >
                        <Video size={8} />
                        Convert to video
                      </button>
                    )}
                  </div>
                </div>
                <div className="px-1.5 pb-1.5 pt-1">
                  <p className="text-[10px] text-muted-foreground line-clamp-2">{p.caption}</p>
                </div>
              </div>
            );
          }

          return (
            <div
              key={vid}
              className={cn(
                "border rounded-lg overflow-hidden transition-colors cursor-pointer",
                a?.approved ? "border-primary/60 bg-primary/5" : "border-border opacity-60",
              )}
              onClick={() => toggleApprove(vid)}
            >
              <div className="relative">
                <img src={`${import.meta.env.VITE_API_URL || ""}${p.imageUrl}`} alt={p.platform} className="w-full aspect-square object-cover" />
                <span className={cn(
                  "absolute top-1 left-1 text-[9px] font-bold px-1 py-0.5 rounded",
                  a?.approved ? "bg-primary text-primary-foreground" : "bg-black/50 text-white",
                )}>
                  {PLATFORM_LABELS[p.platform] || p.platform}
                </span>
                {isConverted && (
                  <span className="absolute bottom-1 left-1 text-[8px] bg-green-600 text-white px-1 py-0.5 rounded flex items-center gap-0.5">
                    <Video size={7} /> Video ready
                  </span>
                )}
                <div className={cn(
                  "absolute top-1 right-1 w-4 h-4 rounded-full border-2 flex items-center justify-center",
                  a?.approved ? "bg-primary border-primary text-white" : "bg-transparent border-white/60",
                )}>
                  {a?.approved && <Check size={9} />}
                </div>
              </div>
              <div className="px-1.5 pb-1.5 pt-1 space-y-1" onClick={e => e.stopPropagation()}>
                <p className="text-[10px] text-muted-foreground line-clamp-2">{p.caption}</p>
                {a?.approved && (
                  <input
                    type="datetime-local"
                    value={dtLocal}
                    onChange={e => setTime(vid, e.target.value)}
                    className="text-[10px] w-full border border-border rounded px-1 py-0.5 bg-background"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {approvedPlatforms.length > 0 && (
        <button
          onClick={handleSchedule}
          className="w-full text-xs py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center justify-center gap-1.5"
        >
          <Calendar size={11} />
          Schedule {approvedPlatforms.length} post{approvedPlatforms.length !== 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}

function TurnCard({ turn, allVariants, onPickTake, onSchedule, onConvertVideo, convertedVariants }: {
  turn: Turn;
  allVariants: Variant[];
  isActive: boolean;
  onPickTake: (variantId: string) => void;
  onSchedule: (schedules: Array<{variantId:string;platform:string;scheduledAt:string}>) => void;
  onConvertVideo: (sourceVariantId: string) => void;
  convertedVariants: Record<string, string>;
}) {
  const isUser = turn.role === "user";
  const isCompare = turn.action === "compare";
  const isFanOut = turn.action === "fan_out";
  const isSchedule = turn.action === "schedule";
  const isVideo = turn.action === "convert_video" || turn.action === "edit_video";
  const variantIds = (turn.resultVariantIds || []) as string[];
  const variantMap = new Map(allVariants.map(v => [v.id, v]));

  const metaPlatforms = turn.metadata?.platforms as FanOutPlatformCard[] | undefined;
  const metaEntryIds = turn.metadata?.entryIds as string[] | undefined;
  const metaRegion = turn.metadata?.region as {x0:number;y0:number;x1:number;y1:number} | undefined;
  const metaVideoUrl = turn.metadata?.videoUrl as string | undefined;
  const metaQaRetried = turn.metadata?.qaRetried as boolean | undefined;

  if (isUser) {
    return (
      <div className="flex items-start gap-2 justify-end">
        <div className="bg-primary/10 border border-primary/20 rounded-lg rounded-tr-none px-3 py-2 max-w-[300px]">
          <p className="text-sm">{turn.instruction || <span className="italic text-muted-foreground">no instruction</span>}</p>
          {metaRegion && (
            <p className="text-[10px] text-primary mt-0.5">
              Region [{(metaRegion.x0 * 100).toFixed(0)}%, {(metaRegion.y0 * 100).toFixed(0)}%] to [{(metaRegion.x1 * 100).toFixed(0)}%, {(metaRegion.y1 * 100).toFixed(0)}%]
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
        {isVideo ? <Video size={14} className="text-primary" /> :
         isFanOut ? <Layers size={14} className="text-primary" /> :
         isSchedule ? <Calendar size={14} className="text-primary" /> :
         <Bot size={14} className="text-primary" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-card border border-border rounded-lg rounded-tl-none p-3 space-y-2">
          {turn.status === "running" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              Working...
            </div>
          )}

          {turn.status === "cancelled" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AlertCircle size={12} />
              Cancelled
            </div>
          )}

          {turn.status === "error" && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle size={12} />
              {turn.error || "Turn failed"}
            </div>
          )}

          {turn.status === "done" && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-primary">{ACTION_LABELS[turn.action] || turn.action}</span>
                {(turn.action === "edit_image" || turn.action === "edit_region") && (
                  <span className="text-xs text-muted-foreground">preserving edit</span>
                )}
                {metaQaRetried && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">QA corrected</span>
                )}
                {turn.costUsd && turn.costUsd > 0 && (
                  <span className="text-xs text-muted-foreground ml-auto">${turn.costUsd.toFixed(4)}</span>
                )}
              </div>

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
                  {metaEntryIds.length} post{metaEntryIds.length !== 1 ? "s" : ""} added to calendar
                </div>
              ) : isVideo && metaVideoUrl ? (
                <div className="flex items-center gap-2 text-xs text-primary">
                  <Play size={12} />
                  Video ready - preview in the right pane
                </div>
              ) : isCompare && variantIds.length > 1 ? (
                <div className="grid grid-cols-3 gap-1.5">
                  {variantIds.slice(0, 3).map((vid, i) => {
                    const v = variantMap.get(vid);
                    const imgUrl = v?.compositedImageUrl || v?.rawImageUrl;
                    return (
                      <button
                        key={vid}
                        onClick={() => onPickTake(vid)}
                        className="relative rounded overflow-hidden border-2 border-border hover:border-primary transition-all group"
                      >
                        {imgUrl ? (
                          <img src={imgUrl} alt={`Take ${i + 1}`} className="w-full aspect-square object-cover" />
                        ) : (
                          <div className="w-full aspect-square bg-muted flex items-center justify-center">
                            <span className="text-xs text-muted-foreground">Take {i + 1}</span>
                          </div>
                        )}
                        <div className="absolute inset-0 bg-primary/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <Check size={20} className="text-white" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : variantIds.length > 0 && !isFanOut ? (
                (() => {
                  const vid = variantIds[0]!;
                  const v = variantMap.get(vid);
                  const imgUrl = v?.compositedImageUrl || v?.rawImageUrl;
                  return imgUrl ? (
                    <div className="w-16 h-16 rounded overflow-hidden border border-border">
                      <img src={imgUrl} alt="Result" className="w-full h-full object-cover" />
                    </div>
                  ) : null;
                })()
              ) : null}
            </>
          )}
        </div>
        {turn.status === "done" && turn.durationMs && (
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1 ml-1">
            <Clock size={10} />
            {(turn.durationMs / 1000).toFixed(1)}s
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Root page -------------------------------------------------------------

export default function CopilotStudio() {
  const { toast } = useToast();
  const canWrite = useCanWrite();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  // Set when a session is created from a concept pick — SessionView pre-fills
  // the composer with it and auto-starts the first draft.
  const [autoDraftBrief, setAutoDraftBrief] = useState<string | null>(null);

  // Read URL params once on mount. ?campaign=<creativeId> opens a pre-seeded
  // session from a plan-item creative. ?session=<id> jumps directly to a session.
  // ?platform=<name> carries the primary platform from a ContentPlan item.
  const { campaignId, urlSessionId, urlPlatform } = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      campaignId: params.get("campaign"),
      urlSessionId: params.get("session"),
      urlPlatform: params.get("platform"),
    };
  })[0];

  // Keep the active session in the URL (?session=<id>) so a page reload —
  // e.g. a dev-server restart or accidental refresh mid-generation — returns
  // the user to their session instead of dumping them on the Studio home.
  const openSession = useCallback((id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("session", id);
    window.history.replaceState({}, "", url.toString());
    setSessionId(id);
  }, []);

  // Consume-once guard: the mount-time ?session snapshot must only restore
  // the session a single time. Without this, closeSession (Back) would set
  // sessionId to null and the effect below would immediately re-apply the
  // stale snapshot, trapping the user in the session view.
  const urlSessionConsumedRef = useRef(false);

  const closeSession = useCallback(() => {
    urlSessionConsumedRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    window.history.replaceState({}, "", url.toString());
    setSessionId(null);
    setAutoDraftBrief(null);
  }, []);

  // Direct session link (or reload restore) — jump straight to the session view.
  useEffect(() => {
    if (urlSessionId && !sessionId && !seeding && !urlSessionConsumedRef.current) {
      urlSessionConsumedRef.current = true;
      setSessionId(urlSessionId);
    }
  }, [urlSessionId, sessionId, seeding]);

  // Deep-link from ContentPlan: fetch the creative's brief + brand, then
  // auto-start a Co-pilot session pre-seeded with that context.
  // seedAttemptedRef ensures the deep-link is consumed exactly once — without
  // it, a failed auto-start would re-trigger this effect forever (seeding
  // flips back to false while campaignId stays set), trapping the user on
  // the loading spinner instead of landing them on the Studio home.
  const seedAttemptedRef = useRef(false);
  useEffect(() => {
    // E2: Viewers cannot create sessions — skip auto-start entirely so they
    // don't hit an avoidable 403 from the editor-gated POST /api/sessions.
    if (!canWrite) return;
    if (!campaignId || urlSessionId || sessionId || seeding || seedAttemptedRef.current) return;
    seedAttemptedRef.current = true;
    setSeeding(true);
    void (async () => {
      try {
        const cResp = await apiFetch(`${API_BASE}/api/creatives/${campaignId}`);
        if (!cResp.ok) throw new Error("Creative not found");
        const creative = await cResp.json() as {
          brandId: string;
          briefText: string | null;
          intent: string | null;
        };

        const baseBrief = creative.briefText?.trim() || "New content";
        const briefText = urlPlatform
          ? `${baseBrief}\nTarget platform: ${urlPlatform}`
          : baseBrief;
        const sResp = await apiFetch(`${API_BASE}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brandId: creative.brandId,
            briefText,
            intent: creative.intent || undefined,
            existingCreativeId: campaignId,
          }),
        });
        if (!sResp.ok) {
          const e = await sResp.json().catch(() => ({})) as { error?: string };
          throw new Error(e.error || "Could not start session");
        }
        const session = await sResp.json() as { id: string };

        const url = new URL(window.location.href);
        url.searchParams.delete("campaign");
        url.searchParams.delete("platform");
        window.history.replaceState({}, "", url.toString());
        openSession(session.id);
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Could not open plan item",
          description: err instanceof Error ? err.message : "Please try again.",
        });
      } finally {
        setSeeding(false);
      }
    })();
  }, [campaignId, urlSessionId, urlPlatform, sessionId, seeding, toast, openSession, canWrite]);

  if (seeding) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Opening your plan item...</p>
        </div>
      </div>
    );
  }

  if (sessionId) {
    return (
      <SessionView
        sessionId={sessionId}
        autoDraftBrief={autoDraftBrief}
        onBack={closeSession}
      />
    );
  }

  return (
    <HomeView
      onSessionCreated={(id, brief) => {
        setAutoDraftBrief(brief ?? null);
        openSession(id);
      }}
    />
  );
}
