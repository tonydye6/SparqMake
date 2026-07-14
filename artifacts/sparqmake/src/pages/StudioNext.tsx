import { useReducer, useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { Dispatch, MouseEvent } from "react";
import { Sparkles, LayoutGrid, Wand2, RefreshCw, ArrowRight, Check, Plus, Loader2, Share2, AlertTriangle, Send, Clapperboard, Music, Volume2, VolumeX } from "lucide-react";
import { FaInstagram, FaXTwitter, FaTiktok, FaLinkedin } from "react-icons/fa6";
import type { IconType } from "react-icons";
import { useGetBrands, useGetTemplates } from "@workspace/api-client-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Client-side cache-buster. When a variant's image is re-composited in place the
// server reuses the same image *path*, so the browser keeps showing the cached
// old bytes. Appending a bumped `?v=N` (or `&v=N` when the URL already has a
// query) forces a re-fetch. Kept local to the card components.
function withImageVersion(url: string, version: number): string {
  if (version <= 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
}

// Studio beats: the P1 spine (Home → Board → Finish) plus Fan-out (P2). Send/Brand are P3.
type Beat = "home" | "board" | "finish" | "fanout";

// A named concept card from the Beat 1 ideation endpoint. Ephemeral until the
// creator picks one; the selection then seeds the Board (and is persisted there).
interface Concept {
  id: string;
  title: string;
  angle: string;
}

// A matched asset offered on the confirm-picks screen, flattened from the
// server's tiered match response.
interface AssetSuggestion {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  description: string | null;
  matchedTerms: string[];
  tier: "image" | "description" | "compositing" | "context";
}

const TIER_LABELS: Record<AssetSuggestion["tier"], string> = {
  image: "Strong match — used as a visual reference",
  description: "Described to the model as text guidance",
  compositing: "Overlaid on the final image",
  context: "Adds brand context",
};

// Attribution chip data returned by GET /creatives/:id/asset-usage.
interface UsedAssetChip {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  fileUrl: string | null;
  role: string;
}

// An asset the creator confirmed for generation. First pick is the primary
// subject reference; the rest ride along as supporting references.
interface SelectedAssetPick {
  assetId: string;
  role: "primary" | "supporting";
}

interface StudioState {
  beat: Beat;
  // The creative is created on entering Board; takes/variants hang off it.
  creativeId: string | null;
  brandId: string | null;
  briefText: string;
  selectedConcept: Concept | null;
  // Confirmed asset picks from the Home beat, persisted onto the creative.
  selectedAssets: SelectedAssetPick[];
  // The take chosen on the Board, carried into Finish.
  selectedVariantId: string | null;
  // Fan-out approve-selection (variant ids checked but not yet approved). Held in
  // the reducer so it survives BeatFanout unmounting when the user navigates
  // between beats; without this the selection is silently lost on every switch.
  fanoutApproved: string[];
}

type StudioAction =
  | { type: "goto"; beat: Beat }
  | { type: "setBrand"; brandId: string }
  | { type: "setBrief"; briefText: string }
  | { type: "selectConcept"; concept: Concept | null }
  | { type: "setSelectedAssets"; assets: SelectedAssetPick[] }
  | { type: "setCreative"; creativeId: string }
  | { type: "selectVariant"; variantId: string }
  | { type: "toggleFanoutApprove"; id: string }
  | { type: "setFanoutApproved"; ids: string[] };

const initialState: StudioState = {
  beat: "home",
  creativeId: null,
  brandId: null,
  briefText: "",
  selectedConcept: null,
  selectedAssets: [],
  selectedVariantId: null,
  fanoutApproved: [],
};

function reducer(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case "goto":
      return { ...state, beat: action.beat };
    case "setBrand":
      // Switching the target brand invalidates everything downstream.
      return {
        ...state,
        brandId: action.brandId,
        selectedConcept: null,
        selectedAssets: [],
        creativeId: null,
        selectedVariantId: null,
        fanoutApproved: [],
      };
    case "setBrief":
      return { ...state, briefText: action.briefText };
    case "selectConcept":
      return { ...state, selectedConcept: action.concept };
    case "setSelectedAssets":
      return { ...state, selectedAssets: action.assets };
    case "setCreative":
      return { ...state, creativeId: action.creativeId };
    case "selectVariant":
      return { ...state, selectedVariantId: action.variantId };
    case "toggleFanoutApprove": {
      const has = state.fanoutApproved.includes(action.id);
      return {
        ...state,
        fanoutApproved: has
          ? state.fanoutApproved.filter((x) => x !== action.id)
          : [...state.fanoutApproved, action.id],
      };
    }
    case "setFanoutApproved":
      return { ...state, fanoutApproved: action.ids };
    default:
      return state;
  }
}

const BEATS: { id: Beat; label: string; icon: typeof Sparkles }[] = [
  { id: "home", label: "Home", icon: Sparkles },
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "finish", label: "Finish", icon: Wand2 },
  { id: "fanout", label: "Fan-out", icon: Share2 },
];

// Which beats are reachable from the current state, mirroring the in-beat
// advance gates. Beats unmount on switch, so jumping forward into a beat that
// has no data discards unsaved work and lands the user on an empty screen.
// Gating the stepper to reachable targets prevents that: Board needs a concept
// or brief (Board self-creates the creative on entry); Finish needs a chosen
// take; Fan-out is reachable once Finish is (Finish → Fan-out has no extra gate).
function canReachBeat(beat: Beat, state: StudioState): boolean {
  switch (beat) {
    case "home":
      return true;
    case "board":
      return Boolean(state.creativeId || state.selectedConcept || state.briefText.trim());
    case "finish":
    case "fanout":
      return Boolean(state.creativeId && state.selectedVariantId);
    default:
      return false;
  }
}

export default function StudioNext() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const activeIndex = BEATS.findIndex((b) => b.id === state.beat);

  return (
    <div className="flex flex-col h-full">
      {/* Beat stepper */}
      <div className="h-16 border-b border-border flex items-center gap-2 px-6 shrink-0">
        {BEATS.map((b, i) => {
          const active = b.id === state.beat;
          const done = i < activeIndex;
          const reachable = active || canReachBeat(b.id, state);
          return (
            <button
              key={b.id}
              onClick={() => dispatch({ type: "goto", beat: b.id })}
              disabled={!reachable}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : done
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                !reachable && "opacity-40 cursor-not-allowed hover:text-muted-foreground",
              )}
            >
              <b.icon size={16} />
              {b.label}
            </button>
          );
        })}
        <span className="ml-auto text-xs text-muted-foreground">
          Creative Studio
        </span>
      </div>

      {/* Beat body */}
      <div className="flex-1 overflow-auto">
        {state.beat === "home" && (
          <BeatHome
            state={state}
            dispatch={dispatch}
            onAdvance={() => dispatch({ type: "goto", beat: "board" })}
          />
        )}
        {state.beat === "board" && (
          <BeatBoard
            state={state}
            dispatch={dispatch}
            onAdvance={() => dispatch({ type: "goto", beat: "finish" })}
          />
        )}
        {state.beat === "finish" && (
          <BeatFinish state={state} onAdvance={() => dispatch({ type: "goto", beat: "fanout" })} />
        )}
        {state.beat === "fanout" && <BeatFanout state={state} dispatch={dispatch} />}
      </div>
    </div>
  );
}

function BeatHome({
  state,
  dispatch,
  onAdvance,
}: {
  state: StudioState;
  dispatch: Dispatch<StudioAction>;
  onAdvance: () => void;
}) {
  const { toast } = useToast();
  const { data: brands, isLoading: brandsLoading } = useGetBrands();
  const [brief, setBrief] = useState(state.briefText);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [loadingConcepts, setLoadingConcepts] = useState(false);
  const [matchLoading, setMatchLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<AssetSuggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const brandId = state.brandId;

  // Default to the first brand once the list loads.
  useEffect(() => {
    if (!brandId && brands && brands.length > 0) {
      dispatch({ type: "setBrand", brandId: brands[0].id });
    }
  }, [brandId, brands, dispatch]);

  const loadConcepts = useCallback(
    async (briefArg?: string) => {
      if (!brandId) return;
      setLoadingConcepts(true);
      try {
        const resp = await apiFetch(`${API_BASE}/api/concept-suggestions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandId, briefText: briefArg?.trim() || undefined }),
        });
        if (!resp.ok) throw new Error("Could not load concepts");
        const data = await resp.json();
        setConcepts(Array.isArray(data.concepts) ? data.concepts : []);
      } catch (err) {
        setConcepts([]);
        toast({
          variant: "destructive",
          title: "Concepts unavailable",
          description: err instanceof Error ? err.message : "Please try again.",
        });
      } finally {
        setLoadingConcepts(false);
      }
    },
    [brandId, toast],
  );

  // Brand-aware home: auto-load concepts whenever the active brand changes.
  useEffect(() => {
    if (brandId) void loadConcepts();
  }, [brandId, loadConcepts]);

  // Matches the brief against the brand's asset library. Only approved assets
  // are offered (generation rejects unapproved picks). If nothing matches, we
  // skip the confirm step and advance straight to the Board.
  const openAssetPicks = useCallback(
    async (briefFull: string) => {
      if (!brandId || !briefFull.trim()) {
        dispatch({ type: "setSelectedAssets", assets: [] });
        onAdvance();
        return;
      }
      setMatchLoading(true);
      try {
        const res = await postJson(`${API_BASE}/api/assets/match`, { brandId, briefText: briefFull });
        const tiers: Array<{ list: any[]; tier: AssetSuggestion["tier"] }> = [
          { list: res.imageReferences || [], tier: "image" },
          { list: res.textDescriptions || [], tier: "description" },
          { list: res.compositing || [], tier: "compositing" },
          { list: res.context || [], tier: "context" },
        ];
        const seen = new Set<string>();
        const flat: AssetSuggestion[] = [];
        for (const { list, tier } of tiers) {
          for (const m of list) {
            const a = m.asset || {};
            if (!a.id || seen.has(a.id) || a.status !== "approved") continue;
            seen.add(a.id);
            flat.push({
              id: a.id,
              name: a.name || "Untitled asset",
              thumbnailUrl: a.thumbnailUrl || a.fileUrl || null,
              description: a.description || null,
              matchedTerms: m.matchedTerms || [],
              tier,
            });
          }
        }
        if (flat.length === 0) {
          dispatch({ type: "setSelectedAssets", assets: [] });
          onAdvance();
          return;
        }
        setSuggestions(flat);
        // Pre-check the image-reference tier — those are the strongest matches.
        setPicked(new Set(flat.filter((s) => s.tier === "image").map((s) => s.id)));
      } catch {
        // Matching is best-effort; never block generation on it.
        dispatch({ type: "setSelectedAssets", assets: [] });
        onAdvance();
      } finally {
        setMatchLoading(false);
      }
    },
    [brandId, dispatch, onAdvance],
  );

  function confirmPicks() {
    if (!suggestions) return;
    const ordered = suggestions.filter((s) => picked.has(s.id));
    dispatch({
      type: "setSelectedAssets",
      assets: ordered.map((s, i) => ({ assetId: s.id, role: i === 0 ? "primary" : "supporting" })),
    });
    setSuggestions(null);
    onAdvance();
  }

  function pickConcept(concept: Concept) {
    dispatch({ type: "setBrief", briefText: brief.trim() });
    dispatch({ type: "selectConcept", concept });
    void openAssetPicks([brief.trim(), `${concept.title}: ${concept.angle}`].filter(Boolean).join("\n"));
  }

  function generateFromPrompt() {
    if (!brief.trim()) {
      toast({
        variant: "destructive",
        title: "Add a brief",
        description: "Type a prompt or pick a concept to start.",
      });
      return;
    }
    dispatch({ type: "setBrief", briefText: brief.trim() });
    dispatch({ type: "selectConcept", concept: null });
    void openAssetPicks(brief.trim());
  }

  if (suggestions) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
            Use these brand assets?
          </h1>
          <p className="text-muted-foreground">
            These approved assets match your brief. Checked assets guide the generated images.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {suggestions.map((s) => {
            const checked = picked.has(s.id);
            return (
              <Card
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.id)) next.delete(s.id);
                    else next.add(s.id);
                    return next;
                  })
                }
                className={cn(
                  "p-3 flex items-start gap-3 cursor-pointer transition-colors",
                  checked ? "border-primary bg-primary/5" : "hover:border-primary/50",
                )}
                data-testid={`asset-pick-${s.id}`}
              >
                <div className="w-16 h-16 rounded-md bg-muted overflow-hidden shrink-0 flex items-center justify-center">
                  {s.thumbnailUrl ? (
                    <img src={`${API_BASE}${s.thumbnailUrl}`} alt={s.name} className="w-full h-full object-cover" />
                  ) : (
                    <Sparkles size={18} className="text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <Checkbox checked={checked} className="pointer-events-none" />
                    <span className="text-sm font-medium text-foreground truncate">{s.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {s.description || TIER_LABELS[s.tier]}
                  </p>
                  {s.matchedTerms.length > 0 && (
                    <p className="text-[11px] text-primary truncate">
                      Matches: {s.matchedTerms.slice(0, 4).join(", ")}
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => {
              dispatch({ type: "setSelectedAssets", assets: [] });
              setSuggestions(null);
              onAdvance();
            }}
            data-testid="asset-picks-skip"
          >
            Skip assets
          </Button>
          <Button onClick={confirmPicks} data-testid="asset-picks-confirm">
            Continue{picked.size > 0 ? ` with ${picked.size} asset${picked.size === 1 ? "" : "s"}` : " without assets"}
            <ArrowRight size={16} className="ml-1.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
      {/* Target brand bar. Brands are targets you create FOR, never product owners. */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Creating for</span>
        <Select
          value={brandId ?? undefined}
          onValueChange={(v) => dispatch({ type: "setBrand", brandId: v })}
          disabled={brandsLoading || !brands || brands.length === 0}
        >
          <SelectTrigger className="w-[220px]" data-testid="studio-next-brand">
            <SelectValue placeholder={brandsLoading ? "Loading brands" : "Select a brand"} />
          </SelectTrigger>
          <SelectContent>
            {(brands ?? []).map((brand) => (
              <SelectItem key={brand.id} value={brand.id}>
                {brand.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Brand-neutral hero. */}
      <div className="space-y-1">
        <h1 className="font-display text-4xl font-semibold tracking-tight text-foreground">
          What are we making today?
        </h1>
        <p className="text-muted-foreground">
          Describe a post, or start from an on-brand concept below.
        </p>
      </div>

      {/* Co-equal free-prompt box (the express path). */}
      <div className="space-y-3">
        <Textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="e.g. Hype the Week 3 rivalry matchup with a trash-talk hook"
          className="min-h-24 resize-none text-base"
          data-testid="studio-next-brief"
        />
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadConcepts(brief)}
            disabled={!brandId || loadingConcepts}
            className="text-muted-foreground"
          >
            <RefreshCw size={14} className={cn("mr-1.5", loadingConcepts && "animate-spin")} />
            Refresh concepts
          </Button>
          <Button onClick={generateFromPrompt} disabled={!brandId || matchLoading} data-testid="studio-next-generate">
            {matchLoading ? (
              <>
                <Loader2 size={16} className="mr-1.5 animate-spin" />
                Matching assets
              </>
            ) : (
              <>
                Generate
                <ArrowRight size={16} className="ml-1.5" />
              </>
            )}
          </Button>
        </div>
      </div>

      {/* On-brand concept cards. */}
      <div className="space-y-3">
        <h2 className="font-display text-lg font-semibold text-foreground">On-brand concepts</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {loadingConcepts
            ? [0, 1, 2].map((i) => (
                <Card key={i} className="p-4 space-y-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-5/6" />
                </Card>
              ))
            : concepts.map((concept) => (
                <Card
                  key={concept.id}
                  role="button"
                  tabIndex={0}
                  className="p-4 flex flex-col gap-2 cursor-pointer transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  onClick={() => pickConcept(concept)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      pickConcept(concept);
                    }
                  }}
                  data-testid={`studio-next-concept-${concept.id}`}
                >
                  <h3 className="font-display font-semibold text-foreground leading-snug">
                    {concept.title}
                  </h3>
                  <p className="text-sm text-muted-foreground flex-1">{concept.angle}</p>
                  <span className="text-xs font-medium text-primary inline-flex items-center">
                    Use this <ArrowRight size={12} className="ml-1" />
                  </span>
                </Card>
              ))}
        </div>
        {!loadingConcepts && concepts.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No concepts yet. Pick a brand, or use Refresh concepts.
          </p>
        )}
      </div>
    </div>
  );
}

// --- Beat 2: Board ---

interface BoardVariant {
  id: string;
  compositedImageUrl: string | null;
  rawImageUrl: string | null;
  varyMode: string | null;
  sourceVariantId: string | null;
  status: string;
  headlineText?: string | null;
  caption?: string | null;
  platform?: string;
  clipWarning?: boolean | null;
  aspectRatio?: string;
  videoUrl?: string | null;
  audioSource?: string | null;
  audioUrl?: string | null;
  mergedVideoUrl?: string | null;
}

const VARY_OPTIONS: { mode: string; label: string }[] = [
  { mode: "more_like_this", label: "More like this" },
  { mode: "keep_style", label: "Keep style" },
  { mode: "keep_subject", label: "Keep subject" },
];

// Thin JSON helpers for the custom (non-CRUD) Studio endpoints, surfacing the
// server's error message. Mirrors the raw-apiFetch convention used by /generate.
async function mutateJson(method: "POST" | "PUT", url: string, body: unknown): Promise<any> {
  const resp = await apiFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || data.message || `Request failed (${resp.status})`);
  }
  return resp.json();
}
const postJson = (url: string, body: unknown) => mutateJson("POST", url, body);
const putJson = (url: string, body: unknown) => mutateJson("PUT", url, body);

// Shown in place of a variant image whose stored file no longer exists (e.g.
// production media written to ephemeral disk and wiped by a republish). The
// server returns 404 for the URL; the <img> onError flips the card into this
// state instead of leaving a broken image icon.
function MissingMedia() {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 p-4 text-center text-muted-foreground">
      <AlertTriangle size={20} />
      <span className="text-xs font-medium text-foreground">Media missing</span>
      <span className="text-[11px] leading-snug">
        The stored file is no longer available. Regenerate to restore it.
      </span>
    </div>
  );
}

// Tracks whether an <img> for the given URL failed to load; resets whenever
// the URL changes (e.g. after a regenerate writes a fresh file).
function useImageError(url: string | null | undefined): [boolean, () => void] {
  const [errorUrl, setErrorUrl] = useState<string | null>(null);
  const failed = Boolean(url) && errorUrl === url;
  const onError = useCallback(() => {
    if (url) setErrorUrl(url);
  }, [url]);
  return [failed, onError];
}

// List endpoints are inconsistent: some return a bare array, some a `{ data: [] }`
// wrapper, and the generated types don't always match runtime. Normalize both.
function asArray<T>(resp: unknown): T[] {
  if (Array.isArray(resp)) return resp as T[];
  if (resp && typeof resp === "object" && Array.isArray((resp as { data?: unknown }).data)) {
    return (resp as { data: T[] }).data;
  }
  return [];
}

function BeatBoard({
  state,
  dispatch,
  onAdvance,
}: {
  state: StudioState;
  dispatch: Dispatch<StudioAction>;
  onAdvance: () => void;
}) {
  const { toast } = useToast();
  const { data: templates } = useGetTemplates(state.brandId ? { brandId: state.brandId } : undefined);
  const [takes, setTakes] = useState<BoardVariant[]>([]);
  const [phase, setPhase] = useState<"working" | "ready" | "error">("working");
  const [varyingId, setVaryingId] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [usedAssets, setUsedAssets] = useState<UsedAssetChip[]>([]);
  const startedRef = useRef(false);

  // Attribution chips: which brand assets this creative was generated with.
  useEffect(() => {
    if (!state.creativeId) {
      setUsedAssets([]);
      return;
    }
    let cancelled = false;
    void apiFetch(`${API_BASE}/api/creatives/${state.creativeId}/asset-usage`)
      .then((r) => (r.ok ? r.json() : { assets: [] }))
      .then((data) => {
        if (!cancelled) setUsedAssets(Array.isArray(data.assets) ? data.assets : []);
      })
      .catch(() => {
        if (!cancelled) setUsedAssets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.creativeId]);

  const generateTakes = useCallback(async (creativeId: string, count: number) => {
    const res = await postJson(`${API_BASE}/api/creatives/${creativeId}/takes`, { count });
    return (res.takes || []) as BoardVariant[];
  }, []);

  // Initialize the board once: reuse an existing creative's takes (on re-entry),
  // or create a creative (auto-picking the brand's first template) and generate
  // an initial take set.
  useEffect(() => {
    if (startedRef.current) return;
    if (!state.brandId) return;
    if (templates === undefined) return; // wait for templates to load
    startedRef.current = true;

    void (async () => {
      setPhase("working");
      try {
        if (state.creativeId) {
          const existing = await apiFetch(`${API_BASE}/api/creatives/${state.creativeId}/variants`)
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => []);
          const arr = asArray<BoardVariant>(existing);
          setTakes(arr.length > 0 ? arr : await generateTakes(state.creativeId, 3));
          setPhase("ready");
          return;
        }

        const templateId = asArray<{ id: string }>(templates)[0]?.id;
        if (!templateId) {
          toast({ variant: "destructive", title: "No template", description: "This brand has no templates to generate with." });
          setPhase("error");
          return;
        }
        const name = state.selectedConcept?.title || (state.briefText ? state.briefText.slice(0, 60) : "Untitled concept");
        const brief = [
          state.briefText,
          state.selectedConcept ? `Concept · ${state.selectedConcept.title}: ${state.selectedConcept.angle}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        const creative = await postJson(`${API_BASE}/api/creatives`, {
          brandId: state.brandId,
          templateId,
          name,
          briefText: brief || undefined,
          selectedAssets: state.selectedAssets,
          createdBy: "self", // server overrides this with the authenticated user
        });
        dispatch({ type: "setCreative", creativeId: creative.id });
        setTakes(await generateTakes(creative.id, 3));
        setPhase("ready");
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Could not start the board",
          description: err instanceof Error ? err.message : "Please try again.",
        });
        setPhase("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.brandId, templates]);

  async function moreTakes() {
    if (!state.creativeId) return;
    setMoreLoading(true);
    try {
      const more = await generateTakes(state.creativeId, 3);
      setTakes((prev) => [...prev, ...more]);
    } catch (err) {
      toast({ variant: "destructive", title: "Could not add takes", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setMoreLoading(false);
    }
  }

  async function vary(take: BoardVariant, mode: string) {
    if (!state.creativeId) return;
    setVaryingId(take.id);
    try {
      const created = await postJson(`${API_BASE}/api/creatives/${state.creativeId}/variants/${take.id}/vary`, { varyMode: mode });
      setTakes((prev) => [...prev, created as BoardVariant]);
    } catch (err) {
      toast({ variant: "destructive", title: "Vary failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setVaryingId(null);
    }
  }

  // Restore a take whose stored media file is gone (e.g. wiped ephemeral disk
  // in production). Replaces the take in place with a freshly generated image.
  async function regenerateTake(take: BoardVariant) {
    if (!state.creativeId) return;
    setVaryingId(take.id);
    try {
      const updated = await postJson(`${API_BASE}/api/creatives/${state.creativeId}/variants/${take.id}/regenerate`, {});
      setTakes((prev) => prev.map((t) => (t.id === take.id ? (updated as BoardVariant) : t)));
    } catch (err) {
      toast({ variant: "destructive", title: "Regenerate failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setVaryingId(null);
    }
  }

  const working = phase === "working";

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Board</h1>
          <p className="text-sm text-muted-foreground">
            Explore takes of your concept. Vary any take to branch a new direction.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={moreTakes} disabled={working || moreLoading || !state.creativeId}>
            {moreLoading ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Plus size={14} className="mr-1.5" />}
            More takes
          </Button>
          <Button size="sm" onClick={onAdvance} disabled={!state.selectedVariantId} data-testid="board-to-finish">
            To Finish
            <ArrowRight size={16} className="ml-1.5" />
          </Button>
        </div>
      </div>

      {usedAssets.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="board-asset-chips">
          <span className="text-xs text-muted-foreground">Made with:</span>
          {usedAssets.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 pl-1 pr-2.5 py-0.5 text-xs text-foreground"
              data-testid={`asset-chip-${a.id}`}
            >
              {a.thumbnailUrl || a.fileUrl ? (
                <img
                  src={`${API_BASE}${a.thumbnailUrl || a.fileUrl}`}
                  alt=""
                  className="w-5 h-5 rounded-full object-cover"
                />
              ) : (
                <Sparkles size={12} className="ml-1 text-muted-foreground" />
              )}
              {a.name}
              {a.role === "primary" && <span className="text-[10px] text-primary font-medium">primary</span>}
            </span>
          ))}
        </div>
      )}

      {working && takes.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-square w-full rounded-xl" />
          ))}
        </div>
      ) : takes.length === 0 ? (
        <div className="text-center text-muted-foreground py-16">
          No takes yet.{" "}
          {state.creativeId && (
            <button onClick={moreTakes} className="text-primary underline">
              Generate takes
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          {takes.map((take) => (
            <VariantCard
              key={take.id}
              take={take}
              selected={state.selectedVariantId === take.id}
              varying={varyingId === take.id}
              onSelect={() => dispatch({ type: "selectVariant", variantId: take.id })}
              onVary={(mode) => vary(take, mode)}
              onRegenerate={() => regenerateTake(take)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VariantCard({
  take,
  selected,
  varying,
  onSelect,
  onVary,
  onRegenerate,
}: {
  take: BoardVariant;
  selected: boolean;
  varying: boolean;
  onSelect: () => void;
  onVary: (mode: string) => void;
  onRegenerate: () => void;
}) {
  const img = take.compositedImageUrl || take.rawImageUrl;
  const [imgMissing, onImgError] = useImageError(img);
  return (
    <Card
      className={cn(
        "overflow-hidden p-0 transition-colors",
        selected ? "border-primary ring-1 ring-primary" : "hover:border-muted-foreground/40",
      )}
    >
      <button onClick={onSelect} className="relative block w-full aspect-square bg-muted" data-testid={`take-${take.id}`}>
        {img && !imgMissing ? (
          <img src={img} alt="Generated take" className="w-full h-full object-cover" onError={onImgError} />
        ) : imgMissing ? (
          <MissingMedia />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">No image</div>
        )}
        {selected && (
          <span className="absolute top-2 right-2 inline-flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground">
            <Check size={14} />
          </span>
        )}
        {take.varyMode && (
          <span className="absolute top-2 left-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {take.varyMode.replace(/_/g, " ")}
          </span>
        )}
        {varying && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 size={20} className="animate-spin text-primary" />
          </span>
        )}
      </button>
      <div className="flex flex-wrap gap-1 p-2 border-t border-border">
        {imgMissing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={varying}
            onClick={onRegenerate}
            data-testid={`take-regenerate-${take.id}`}
          >
            {varying ? <Loader2 size={12} className="mr-1 animate-spin" /> : <RefreshCw size={12} className="mr-1" />}
            Regenerate
          </Button>
        ) : (
          VARY_OPTIONS.map((opt) => (
            <Button
              key={opt.mode}
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              disabled={varying}
              onClick={() => onVary(opt.mode)}
            >
              {opt.label}
            </Button>
          ))
        )}
      </div>
    </Card>
  );
}

// --- Beat 3: Finish (the two-speed surface) ---
// Instant lane: headline + caption edits recomposite/save with no model call.
// Model lane: Regenerate calls the image model. Speed is implicit in what you touch.
function BeatFinish({ state, onAdvance }: { state: StudioState; onAdvance: () => void }) {
  const { toast } = useToast();
  const [variant, setVariant] = useState<BoardVariant | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "missing">("loading");
  const [headline, setHeadline] = useState("");
  const [caption, setCaption] = useState("");
  const [savingHeadline, setSavingHeadline] = useState(false);
  const [savingCaption, setSavingCaption] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [imgV, setImgV] = useState(0);
  const startedRef = useRef(false);
  // Computed before the early returns below so the hook order stays stable.
  const img = variant ? variant.compositedImageUrl || variant.rawImageUrl : null;
  const imgSrc = img ? withImageVersion(img, imgV) : null;
  const [imgMissing, onImgError] = useImageError(imgSrc);

  // Load the take chosen on the Board (variants live on the server).
  useEffect(() => {
    if (startedRef.current) return;
    if (!state.creativeId || !state.selectedVariantId) {
      setPhase("missing");
      return;
    }
    startedRef.current = true;
    void (async () => {
      try {
        const resp = await apiFetch(`${API_BASE}/api/creatives/${state.creativeId}/variants`)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []);
        const found = asArray<BoardVariant>(resp).find((v) => v.id === state.selectedVariantId) || null;
        if (!found) {
          setPhase("missing");
          return;
        }
        setVariant(found);
        setHeadline(found.headlineText || "");
        setCaption(found.caption || "");
        setPhase("ready");
      } catch {
        setPhase("missing");
      }
    })();
  }, [state.creativeId, state.selectedVariantId]);

  async function applyHeadline() {
    if (!variant || !state.creativeId || !headline.trim()) return;
    setSavingHeadline(true);
    try {
      const updated = await putJson(`${API_BASE}/api/creatives/${state.creativeId}/variants/${variant.id}/headline`, { headline: headline.trim() });
      setVariant(updated as BoardVariant);
      // Headline recomposite reuses the same image path — bump to bust the cache.
      setImgV((v) => v + 1);
      toast({ title: "Headline updated" });
    } catch (err) {
      toast({ variant: "destructive", title: "Update failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setSavingHeadline(false);
    }
  }

  async function applyCaption() {
    if (!variant || !state.creativeId || !caption.trim()) return;
    setSavingCaption(true);
    try {
      const updated = await putJson(`${API_BASE}/api/creatives/${state.creativeId}/variants/${variant.id}/caption`, { caption: caption.trim() });
      setVariant(updated as BoardVariant);
      toast({ title: "Caption saved" });
    } catch (err) {
      toast({ variant: "destructive", title: "Update failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setSavingCaption(false);
    }
  }

  async function regenerate() {
    if (!variant || !state.creativeId) return;
    setRegenerating(true);
    try {
      const updated = await postJson(`${API_BASE}/api/creatives/${state.creativeId}/variants/${variant.id}/regenerate`, {});
      setVariant(updated as BoardVariant);
      setImgV((v) => v + 1);
      toast({ title: "Regenerated" });
    } catch (err) {
      toast({ variant: "destructive", title: "Regenerate failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setRegenerating(false);
    }
  }

  if (phase === "missing") {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center text-muted-foreground">
        Pick a take on the Board to finish it.
      </div>
    );
  }
  if (phase === "loading" || !variant) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-10">
      <div className="grid gap-8 md:grid-cols-2">
      {/* Finished composite preview */}
      <div className="space-y-2">
        <Card className="overflow-hidden p-0 bg-muted">
          {imgSrc && !imgMissing ? (
            <img src={imgSrc} alt="Finished composite" className="w-full aspect-square object-cover" onError={onImgError} />
          ) : imgMissing ? (
            <div className="aspect-square">
              <MissingMedia />
            </div>
          ) : (
            <div className="aspect-square flex items-center justify-center text-muted-foreground">No image</div>
          )}
        </Card>
        <p className="text-xs text-muted-foreground">
          Headline edits recomposite instantly. Regenerate calls the image model.
        </p>
      </div>

      {/* Edit lanes */}
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Finish</h1>
          <p className="text-sm text-muted-foreground">Polish the post. Scheduling and publishing come next.</p>
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            On-frame headline <span className="font-normal text-muted-foreground">· instant</span>
          </h2>
          <Textarea
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder="Headline text on the image"
            className="min-h-16 resize-none"
            data-testid="finish-headline"
          />
          <Button size="sm" onClick={applyHeadline} disabled={savingHeadline || !headline.trim()}>
            {savingHeadline && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Apply headline
          </Button>
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            Post caption <span className="font-normal text-muted-foreground">· instant</span>
          </h2>
          <Textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="The caption that posts with this image"
            className="min-h-24 resize-none"
            data-testid="finish-caption"
          />
          <Button size="sm" variant="outline" onClick={applyCaption} disabled={savingCaption || !caption.trim()}>
            {savingCaption && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Save caption
          </Button>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-foreground">
            Regenerate image <span className="font-normal text-muted-foreground">· model call</span>
          </h2>
          <p className="text-xs text-muted-foreground">Generates a fresh image for this take. Costs a generation.</p>
          <Button size="sm" variant="outline" onClick={regenerate} disabled={regenerating}>
            {regenerating ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <RefreshCw size={14} className="mr-1.5" />}
            Regenerate
          </Button>
        </div>

        <Button onClick={onAdvance} className="w-full" data-testid="finish-to-fanout">
          Make platform set
          <Share2 size={16} className="ml-1.5" />
        </Button>
      </div>
      </div>

      {/* Video + audio lane. Video generation and ElevenLabs audio are model
          calls; the merged result is what gets scheduled, published, and
          downloaded (publish/download already prefer mergedVideoUrl). */}
      {state.creativeId && <FinishVideoSection creativeId={state.creativeId} />}
    </div>
  );
}

// --- Finish: video + audio ---

const VIDEO_ORIENTATIONS: { key: "landscape" | "portrait"; label: string }[] = [
  { key: "landscape", label: "Landscape (16:9)" },
  { key: "portrait", label: "Portrait (9:16)" },
];

// The Veo clip length (see server VIDEO_CONFIGS/durationSeconds) — generated
// audio is requested at the same duration so it matches the clip.
const CLIP_DURATION_SEC = 6;

const AUDIO_SOURCE_LABELS: Record<string, string> = {
  veo_native: "Original audio",
  elevenlabs_music: "AI music",
  elevenlabs_sfx: "AI sound effect",
  mute: "Muted",
  custom_upload: "Custom audio",
};

function FinishVideoSection({ creativeId }: { creativeId: string }) {
  const { toast } = useToast();
  const [videoVariants, setVideoVariants] = useState<BoardVariant[]>([]);
  const [orientation, setOrientation] = useState<"landscape" | "portrait">("landscape");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/variants`);
      const arr = asArray<BoardVariant>(resp.ok ? await resp.json() : []);
      setVideoVariants(arr.filter((v) => v.videoUrl));
    } catch {
      /* keep whatever we had */
    }
  }, [creativeId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The generate endpoint streams SSE over a POST, so EventSource won't work —
  // read the fetch body and parse `event:`/`data:` frames by hand.
  async function generateVideoClip() {
    setGenerating(true);
    setProgress("Starting video generation…");
    let failed: string | null = null;
    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/generate-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orientations: [orientation] }),
      });
      if (!resp.ok || !resp.body) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || data.message || `Request failed (${resp.status})`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          let event = "message";
          let data: Record<string, unknown> = {};
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) {
              try {
                data = JSON.parse(line.slice(6));
              } catch {
                /* skip malformed frame */
              }
            }
          }
          if (event === "error") {
            failed = String(data.message || "Video generation failed");
          } else if (event === "video_progress") {
            if (data.status === "failed") failed = String(data.error || "Video generation failed");
            else if (data.status === "completed") setProgress("Video ready — finishing up…");
            else if (data.message) setProgress(String(data.message));
          } else if (event === "progress" && data.message) {
            setProgress(String(data.message));
          }
        }
      }
      if (failed) throw new Error(failed);
      await reload();
      toast({ title: "Video ready", description: "Add music or a sound effect below, then preview the result." });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Video generation failed",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }

  function patchVideoVariant(updated: BoardVariant) {
    setVideoVariants((prev) => prev.map((v) => (v.id === updated.id ? { ...v, ...updated } : v)));
  }

  return (
    <div className="space-y-4 border-t border-border pt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground inline-flex items-center gap-2">
            <Clapperboard size={18} /> Video
            <span className="text-sm font-normal text-muted-foreground">· model call</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            Generate a short clip for this concept, then add on-brand audio. Video and audio each cost a generation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={orientation}
            onValueChange={(v) => setOrientation(v as "landscape" | "portrait")}
            disabled={generating}
          >
            <SelectTrigger className="w-[180px]" data-testid="video-orientation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VIDEO_ORIENTATIONS.map((o) => (
                <SelectItem key={o.key} value={o.key}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={generateVideoClip} disabled={generating} data-testid="generate-video">
            {generating ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Clapperboard size={14} className="mr-1.5" />}
            Generate video
          </Button>
        </div>
      </div>

      {generating && (
        <p className="text-sm text-muted-foreground inline-flex items-center" data-testid="video-progress">
          <Loader2 size={14} className="mr-2 animate-spin" />
          {progress || "Generating video… this can take a minute or two."}
        </p>
      )}

      {videoVariants.length === 0 && !generating ? (
        <p className="text-sm text-muted-foreground">No video yet. Generate one to add audio.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {videoVariants.map((v) => (
            <VideoAudioCard key={v.id} variant={v} creativeId={creativeId} onPatched={patchVideoVariant} />
          ))}
        </div>
      )}
    </div>
  );
}

function VideoAudioCard({
  variant,
  creativeId,
  onPatched,
}: {
  variant: BoardVariant;
  creativeId: string;
  onPatched: (v: BoardVariant) => void;
}) {
  const { toast } = useToast();
  const [audioType, setAudioType] = useState<"music" | "sfx" | "mute">("music");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"replace" | "mix">("replace");
  const [applying, setApplying] = useState(false);

  // Preview the merged file when audio has been applied; merged filenames are
  // timestamped, so a new merge always gets a fresh URL (no cache-busting needed).
  const src = variant.mergedVideoUrl || variant.videoUrl;
  const needsPrompt = audioType === "music" || audioType === "sfx";
  const sourceLabel = variant.audioSource ? AUDIO_SOURCE_LABELS[variant.audioSource] || variant.audioSource : null;

  async function applyAudio() {
    if (needsPrompt && !prompt.trim()) {
      toast({ variant: "destructive", title: "Add a prompt", description: "Describe the music or sound effect you want." });
      return;
    }
    setApplying(true);
    try {
      const updated = await postJson(`${API_BASE}/api/creatives/${creativeId}/variants/${variant.id}/audio`, {
        type: audioType,
        prompt: needsPrompt ? prompt.trim() : undefined,
        mode,
        durationSeconds: CLIP_DURATION_SEC,
      });
      onPatched(updated as BoardVariant);
      toast({
        title: audioType === "mute" ? "Audio muted" : "Audio added",
        description: "Preview the updated clip to hear the result.",
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Audio failed",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setApplying(false);
    }
  }

  return (
    <Card className="overflow-hidden p-0 flex flex-col">
      <div className="bg-muted">
        {src ? (
          <video
            key={src}
            src={src.startsWith("/") ? `${API_BASE}${src}` : src}
            controls
            preload="metadata"
            className={cn("w-full bg-black", variant.aspectRatio === "9:16" ? "max-h-96 aspect-[9/16] mx-auto" : "aspect-video")}
            data-testid={`video-preview-${variant.id}`}
          />
        ) : (
          <div className="aspect-video flex items-center justify-center text-xs text-muted-foreground">No video</div>
        )}
      </div>

      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {variant.aspectRatio === "9:16" ? "Portrait" : "Landscape"}
          </span>
          {sourceLabel && (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
              {variant.audioSource === "mute" ? <VolumeX size={11} /> : <Volume2 size={11} />}
              {sourceLabel}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Select value={audioType} onValueChange={(v) => setAudioType(v as "music" | "sfx" | "mute")} disabled={applying}>
            <SelectTrigger data-testid={`audio-type-${variant.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="music">AI music</SelectItem>
              <SelectItem value="sfx">Sound effect</SelectItem>
              <SelectItem value="mute">Mute audio</SelectItem>
            </SelectContent>
          </Select>
          <Select value={mode} onValueChange={(v) => setMode(v as "replace" | "mix")} disabled={applying || audioType === "mute"}>
            <SelectTrigger data-testid={`audio-mode-${variant.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="replace">Replace original audio</SelectItem>
              <SelectItem value="mix">Mix with original</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {needsPrompt && (
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              audioType === "music"
                ? "e.g. Upbeat electronic track with a driving beat"
                : "e.g. Crowd cheering with a stadium air horn"
            }
            className="min-h-16 resize-none text-sm"
            disabled={applying}
            data-testid={`audio-prompt-${variant.id}`}
          />
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {needsPrompt ? `Matched to the ${CLIP_DURATION_SEC}s clip · costs a generation` : "Removes the audio track · free"}
          </span>
          <Button size="sm" onClick={applyAudio} disabled={applying} data-testid={`apply-audio-${variant.id}`}>
            {applying ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Music size={14} className="mr-1.5" />}
            {variant.mergedVideoUrl ? "Redo audio" : "Add audio"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// --- Beat 4: Fan-out (N1) ---

const FANOUT_PLATFORMS: { key: string; group: string; sub?: string; Icon: IconType }[] = [
  { key: "instagram_feed", group: "Instagram", sub: "Feed", Icon: FaInstagram },
  { key: "instagram_story", group: "Instagram", sub: "Story", Icon: FaInstagram },
  { key: "twitter", group: "X", Icon: FaXTwitter },
  { key: "linkedin", group: "LinkedIn", Icon: FaLinkedin },
  { key: "tiktok", group: "TikTok", Icon: FaTiktok },
];
const PLATFORM_META: Record<string, { group: string; sub?: string; Icon: IconType }> = Object.fromEntries(
  FANOUT_PLATFORMS.map((p) => [p.key, { group: p.group, sub: p.sub, Icon: p.Icon }]),
);

function BeatFanout({ state, dispatch }: { state: StudioState; dispatch: Dispatch<StudioAction> }) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<"select" | "working" | "ready">("select");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(FANOUT_PLATFORMS.map((p) => p.key)));
  const [variants, setVariants] = useState<BoardVariant[]>([]);
  // Approve-selection lives in the reducer so it survives this beat unmounting
  // on navigation (see StudioState.fanoutApproved).
  const approveIds = useMemo(() => new Set(state.fanoutApproved), [state.fanoutApproved]);
  const [approving, setApproving] = useState(false);
  const startedRef = useRef(false);

  // On entry, reload any existing fan-out variants for this winner (re-entry).
  // Fan-out children carry the winner as sourceVariantId and have no varyMode
  // (which distinguishes them from Vary siblings).
  useEffect(() => {
    if (startedRef.current) return;
    if (!state.creativeId || !state.selectedVariantId) return;
    startedRef.current = true;
    void (async () => {
      try {
        const resp = await apiFetch(`${API_BASE}/api/creatives/${state.creativeId}/variants`)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []);
        const children = asArray<BoardVariant>(resp).filter(
          (v) => v.sourceVariantId === state.selectedVariantId && !v.varyMode,
        );
        if (children.length > 0) {
          setVariants(children);
          setPhase("ready");
        }
      } catch {
        /* stay on the select screen */
      }
    })();
  }, [state.creativeId, state.selectedVariantId]);

  function togglePlatform(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function makePlatformSet() {
    if (!state.creativeId || !state.selectedVariantId || selected.size === 0) return;
    setPhase("working");
    try {
      const res = await postJson(
        `${API_BASE}/api/creatives/${state.creativeId}/variants/${state.selectedVariantId}/fan-out`,
        { platforms: Array.from(selected) },
      );
      setVariants((res.variants || []) as BoardVariant[]);
      // Fresh variant ids — drop any stale approve-selection.
      dispatch({ type: "setFanoutApproved", ids: [] });
      setPhase("ready");
    } catch (err) {
      toast({ variant: "destructive", title: "Fan-out failed", description: err instanceof Error ? err.message : "Please try again." });
      setPhase("select");
    }
  }

  function patchVariant(updated: BoardVariant) {
    setVariants((prev) => prev.map((v) => (v.id === updated.id ? updated : v)));
  }

  function toggleApprove(id: string) {
    dispatch({ type: "toggleFanoutApprove", id });
  }

  async function approveSelected() {
    if (!state.creativeId || approveIds.size === 0) return;
    setApproving(true);
    try {
      await postJson(`${API_BASE}/api/creatives/${state.creativeId}/variants/bulk-update`, {
        variantIds: Array.from(approveIds),
        status: "approved",
      });
      setVariants((prev) => prev.map((v) => (approveIds.has(v.id) ? { ...v, status: "approved" } : v)));
      dispatch({ type: "setFanoutApproved", ids: [] });
      toast({ title: "Approved", description: "Selected platform posts are approved." });
    } catch (err) {
      toast({ variant: "destructive", title: "Approve failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setApproving(false);
    }
  }

  if (phase === "select") {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Make platform set</h1>
          <p className="text-sm text-muted-foreground">
            Reframe your winning take to each platform, with a caption tuned per channel. No regeneration.
          </p>
        </div>
        {!state.selectedVariantId ? (
          <p className="text-muted-foreground">Pick and finish a take first.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {FANOUT_PLATFORMS.map((p) => {
                const on = selected.has(p.key);
                return (
                  <button
                    key={p.key}
                    onClick={() => togglePlatform(p.key)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg border p-3 text-left transition-colors",
                      on ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/40",
                    )}
                    data-testid={`fanout-platform-${p.key}`}
                  >
                    <p.Icon size={20} className={on ? "text-foreground" : "text-muted-foreground"} />
                    <span className="text-sm font-medium text-foreground">
                      {p.group}
                      {p.sub && <span className="text-muted-foreground font-normal"> · {p.sub}</span>}
                    </span>
                    {on && <Check size={15} className="ml-auto text-primary" />}
                  </button>
                );
              })}
            </div>
            <Button onClick={makePlatformSet} disabled={selected.size === 0} data-testid="fanout-make-set">
              Make platform set ({selected.size})
              <ArrowRight size={16} className="ml-1.5" />
            </Button>
          </>
        )}
      </div>
    );
  }

  if (phase === "working") {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-4">
        <p className="text-sm text-muted-foreground inline-flex items-center">
          <Loader2 size={14} className="mr-2 animate-spin" /> Reframing to {selected.size} platforms...
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from(selected).map((k) => (
            <Skeleton key={k} className="aspect-square w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const approvedCount = variants.filter((v) => v.status === "approved").length;
  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Platform set</h1>
          <p className="text-sm text-muted-foreground">
            {variants.length} variants · {approvedCount} approved. Edit captions, fix any clipped subjects, then approve.
          </p>
        </div>
        <Button onClick={approveSelected} disabled={approving || approveIds.size === 0} data-testid="fanout-approve">
          {approving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Check size={16} className="mr-1.5" />}
          Approve {approveIds.size > 0 ? `(${approveIds.size})` : "selected"}
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {variants.map((v) => (
          <FanoutCard
            key={v.id}
            variant={v}
            creativeId={state.creativeId ?? ""}
            selectedForApprove={approveIds.has(v.id)}
            onToggleApprove={() => toggleApprove(v.id)}
            onPatched={patchVariant}
          />
        ))}
      </div>
    </div>
  );
}

function FanoutCard({
  variant,
  creativeId,
  selectedForApprove,
  onToggleApprove,
  onPatched,
}: {
  variant: BoardVariant;
  creativeId: string;
  selectedForApprove: boolean;
  onToggleApprove: () => void;
  onPatched: (v: BoardVariant) => void;
}) {
  const { toast } = useToast();
  const meta = variant.platform ? PLATFORM_META[variant.platform] : undefined;
  const Icon = meta?.Icon;
  const [busy, setBusy] = useState<null | "refocus" | "outpaint" | "caption">(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [caption, setCaption] = useState(variant.caption || "");
  const [imgV, setImgV] = useState(0);
  const img = variant.compositedImageUrl || variant.rawImageUrl;
  const imgSrc = img ? withImageVersion(img, imgV) : null;
  const [imgMissing, onImgError] = useImageError(imgSrc);
  const approved = variant.status === "approved";

  // Click the image to recenter the crop on that point (free re-reframe).
  async function nudge(e: MouseEvent<HTMLButtonElement>) {
    if (busy) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setBusy("refocus");
    try {
      const updated = await putJson(`${API_BASE}/api/creatives/${creativeId}/variants/${variant.id}/refocus`, { focalX: x, focalY: y });
      onPatched(updated as BoardVariant);
      setImgV((v) => v + 1);
    } catch (err) {
      toast({ variant: "destructive", title: "Nudge failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setBusy(null);
    }
  }

  async function extendBackground() {
    if (busy) return;
    setBusy("outpaint");
    try {
      const updated = await postJson(`${API_BASE}/api/creatives/${creativeId}/variants/${variant.id}/outpaint`, {});
      onPatched(updated as BoardVariant);
      setImgV((v) => v + 1);
    } catch (err) {
      toast({ variant: "destructive", title: "Extend background failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setBusy(null);
    }
  }

  async function saveCaption() {
    if ((caption || "") === (variant.caption || "") || !caption.trim()) return;
    setBusy("caption");
    try {
      const updated = await putJson(`${API_BASE}/api/creatives/${creativeId}/variants/${variant.id}/caption`, { caption: caption.trim() });
      onPatched(updated as BoardVariant);
    } catch (err) {
      toast({ variant: "destructive", title: "Caption save failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setBusy(null);
    }
  }

  // Send tail: schedule this approved variant. Defaults to tomorrow 9am (adjust on
  // the Calendar). Creates a calendar entry that the Calendar can then publish.
  async function schedule() {
    setScheduling(true);
    try {
      const when = new Date();
      when.setDate(when.getDate() + 1);
      when.setHours(9, 0, 0, 0);
      await postJson(`${API_BASE}/api/calendar-entries`, {
        creativeId,
        variantId: variant.id,
        platform: variant.platform,
        scheduledAt: when.toISOString(),
      });
      setScheduled(true);
      toast({ title: "Added to Calendar", description: "Scheduled for tomorrow 9am. Adjust or publish on the Calendar." });
    } catch (err) {
      toast({ variant: "destructive", title: "Schedule failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setScheduling(false);
    }
  }

  return (
    <Card className={cn("overflow-hidden p-0 flex flex-col", approved && "border-primary")}>
      <button
        onClick={nudge}
        className="relative block w-full aspect-square bg-muted cursor-crosshair"
        title={variant.clipWarning ? "Subject clipped — click it to recenter the crop" : "Click to recenter the crop"}
      >
        {imgSrc && !imgMissing ? (
          <img src={imgSrc} alt={`${meta?.group || variant.platform || "platform"} variant`} className="w-full h-full object-cover" onError={onImgError} />
        ) : imgMissing ? (
          <MissingMedia />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">No image</div>
        )}
        {variant.clipWarning && (
          <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded bg-destructive/90 px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground">
            <AlertTriangle size={11} /> subject clipped
          </span>
        )}
        {busy && busy !== "caption" && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 size={20} className="animate-spin text-primary" />
          </span>
        )}
      </button>

      <div className="flex flex-col gap-2 p-3 flex-1">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={16} className="text-foreground" />}
          <span className="text-sm font-medium text-foreground">
            {meta?.group || variant.platform}
            {meta?.sub && <span className="text-muted-foreground font-normal"> · {meta.sub}</span>}
          </span>
          {approved && <Check size={15} className="ml-auto text-primary" />}
        </div>

        {variant.clipWarning && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs self-start" disabled={!!busy} onClick={extendBackground}>
            {busy === "outpaint" ? <Loader2 size={12} className="mr-1 animate-spin" /> : null}
            Extend background
          </Button>
        )}

        <Textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={saveCaption}
          placeholder="Caption"
          className="min-h-16 resize-none text-xs flex-1"
        />

        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox checked={selectedForApprove} onCheckedChange={() => onToggleApprove()} disabled={approved} />
            {approved ? "Approved" : "Select to approve"}
          </label>
          {approved && (
            <Button
              size="sm"
              variant={scheduled ? "ghost" : "outline"}
              className="h-7 px-2 text-xs"
              disabled={scheduling || scheduled}
              onClick={schedule}
            >
              {scheduling ? <Loader2 size={12} className="mr-1 animate-spin" /> : scheduled ? <Check size={12} className="mr-1" /> : <Send size={12} className="mr-1" />}
              {scheduled ? "Scheduled" : "Schedule"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
