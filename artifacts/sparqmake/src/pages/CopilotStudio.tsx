/**
 * Co-pilot Studio: session-based creative partner at /copilot.
 *
 * Two views:
 *   Home    — start a session (pickers + brief + concept cards) + continue rail
 *   Session — two-pane conversational studio (thread + live preview + history)
 */

import { useState, useCallback, useEffect, useRef, useReducer } from "react";
import {
  Sparkles, Bot, ArrowRight, RotateCcw, MessageSquare,
  Loader2, Clock, ChevronRight, Image as ImageIcon, DollarSign,
  Check, History, X, AlertCircle, Send,
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
  status: "pending" | "running" | "done" | "error";
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
  caption: string;
  headlineText: string | null;
}

// ---- Home view -------------------------------------------------------------

interface HomeViewProps {
  onSessionCreated: (sessionId: string) => void;
}

function HomeView({ onSessionCreated }: HomeViewProps) {
  const { toast } = useToast();
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
      onSessionCreated(session.id);
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
  action: "draft" | "edit_image" | "caption" | "compare";
  instruction: string;
  comingSoon?: boolean;
};

const CHIPS: ComposerChip[] = [
  { label: "Make it bolder", action: "edit_image", instruction: "Make the composition bolder and more energetic" },
  { label: "New take", action: "compare", instruction: "Generate 3 fresh takes" },
  { label: "Punchier caption", action: "caption", instruction: "Rewrite all captions to be punchier and more engaging" },
  { label: "Convert to video", action: "edit_image", instruction: "Convert to video", comingSoon: true },
  { label: "Make platform set", action: "edit_image", instruction: "Make platform set", comingSoon: true },
];

interface SessionViewProps {
  sessionId: string;
  onBack: () => void;
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
  | { type: "setCaptionAlternates"; alternates: Array<{ caption: string; headline: string }> | null; platform: string | null };

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
  caption: "Caption rewrite",
  compare: "Compare takes",
};


const PLATFORM_OPTIONS = [
  { value: "all", label: "All" },
  { value: "instagram_feed", label: "IG Feed" },
  { value: "instagram_story", label: "IG Story" },
  { value: "twitter", label: "Twitter" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "tiktok", label: "TikTok" },
] as const;

function SessionView({ sessionId, onBack }: SessionViewProps) {
  const { toast } = useToast();
  // Platform target for caption turns — "all" means rewrite every platform
  const [captionTargetPlatform, setCaptionTargetPlatform] = useState<string>("all");
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
          const vData = await vResp.json() as { variants?: Variant[]; data?: Variant[] };
          variants = vData.variants || vData.data || [];
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

  const runTurn = useCallback(async (action: "draft" | "edit_image" | "caption" | "compare", instruction: string, platform?: string) => {
    if (state.running) return;
    dispatch({ type: "setRunning", running: true });
    dispatch({ type: "clearProgress" });
    dispatch({ type: "setError", error: null });

    try {
      const resp = await apiFetch(`${API_BASE}/api/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, instruction, platform, compareCount: action === "compare" ? 3 : undefined }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No SSE stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
              if (data.message) dispatch({ type: "addProgress", message: data.message as string });
              if (data.alternates) {
                dispatch({
                  type: "setCaptionAlternates",
                  alternates: data.alternates as Array<{ caption: string; headline: string }>,
                  platform: platform || null,
                });
              }
            } catch {}
          }
          if (line.startsWith("event: error")) {
            const dataLine = lines[lines.indexOf(line) + 1];
            if (dataLine?.startsWith("data: ")) {
              const errData = JSON.parse(dataLine.slice(6)) as { message?: string };
              throw new Error(errData.message || "Turn failed");
            }
          }
        }
      }

      await loadSession();
      dispatch({ type: "setComposer", text: "" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "setError", error: msg });
      toast({ variant: "destructive", title: "Turn failed", description: msg });
    } finally {
      dispatch({ type: "setRunning", running: false });
    }
  }, [sessionId, state.running, loadSession, toast]);

  const handleDraft = useCallback(() => {
    if (!state.composerText.trim()) return;
    void runTurn("draft", state.composerText);
  }, [state.composerText, runTurn]);

  const handleSend = useCallback(() => {
    if (!state.composerText.trim() || state.running) return;
    const text = state.composerText.trim();
    const hasPrev = state.session?.imageInteractionId;
    if (!hasPrev) {
      void runTurn("draft", text);
    } else {
      const isCaption = /caption|headline|copy|text|punchier|shorter|hashtag/i.test(text);
      if (isCaption) {
        const platform = captionTargetPlatform === "all" ? undefined : captionTargetPlatform;
        void runTurn("caption", text, platform);
      } else {
        void runTurn("edit_image", text);
      }
    }
  }, [state.composerText, state.running, state.session, captionTargetPlatform, runTurn]);

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
                onPickTake={(variantId) => void pickCompareTake(turn.id, variantId)}
              />
            ))}

            {state.running && state.progressMessages.length > 0 && (
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 space-y-1">
                {state.progressMessages.map((msg, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-primary">
                    <Loader2 size={12} className="animate-spin shrink-0" />
                    {msg}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-border p-3 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {CHIPS.filter(c => !c.comingSoon).map(chip => (
                <button
                  key={chip.label}
                  onClick={() => void runTurn(chip.action, chip.instruction)}
                  disabled={state.running}
                  className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-primary/10 hover:border-primary/40 transition-colors disabled:opacity-40"
                >
                  {chip.label}
                </button>
              ))}
              {CHIPS.filter(c => c.comingSoon).map(chip => (
                <span key={chip.label} className="text-xs px-2.5 py-1 rounded-full border border-dashed border-border text-muted-foreground cursor-not-allowed">
                  {chip.label}
                </span>
              ))}
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

            <div className="flex gap-2">
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
            {state.error && (
              <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                <AlertCircle size={12} />
                {state.error}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-auto p-6 flex items-center justify-center">
            {activeVariant ? (
              <div className="w-full max-w-sm space-y-4">
                <div className="relative rounded-xl overflow-hidden shadow-lg border border-border bg-card">
                  <img
                    src={activeVariant.compositedImageUrl || activeVariant.rawImageUrl || ""}
                    alt="Generated post"
                    className="w-full aspect-square object-cover"
                  />
                  {activeVariant.headlineText && (
                    <div className="absolute inset-0 flex items-end p-4 bg-gradient-to-t from-black/60 to-transparent">
                      <p className="text-white font-bold text-lg leading-tight">{activeVariant.headlineText}</p>
                    </div>
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
                      onClick={() => void runTurn("caption", `${tune} — rewrite the caption`)}
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

function TurnCard({ turn, allVariants, onPickTake }: {
  turn: Turn;
  allVariants: Variant[];
  isActive: boolean;
  onPickTake: (variantId: string) => void;
}) {
  const isUser = turn.role === "user";
  const isCompare = turn.action === "compare";
  const variantIds = (turn.resultVariantIds || []) as string[];
  const variantMap = new Map(allVariants.map(v => [v.id, v]));

  if (isUser) {
    return (
      <div className="flex items-start gap-2 justify-end">
        <div className="bg-primary/10 border border-primary/20 rounded-lg rounded-tr-none px-3 py-2 max-w-[300px]">
          <p className="text-sm">{turn.instruction}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
        <Bot size={14} className="text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-card border border-border rounded-lg rounded-tl-none p-3 space-y-2">
          {turn.status === "running" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              Working...
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
                {turn.action === "edit_image" && (
                  <span className="text-xs text-muted-foreground">not a re-roll</span>
                )}
                {turn.costUsd && turn.costUsd > 0 && (
                  <span className="text-xs text-muted-foreground ml-auto">${turn.costUsd.toFixed(4)}</span>
                )}
              </div>

              {isCompare && variantIds.length > 1 ? (
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
              ) : variantIds.length > 0 ? (
                (() => {
                  const vid = variantIds[0];
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
  const [sessionId, setSessionId] = useState<string | null>(null);

  if (sessionId) {
    return <SessionView sessionId={sessionId} onBack={() => setSessionId(null)} />;
  }

  return <HomeView onSessionCreated={(id) => setSessionId(id)} />;
}
