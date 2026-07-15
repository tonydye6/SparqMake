import { useReducer, useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { Dispatch, MouseEvent } from "react";
import { Sparkles, LayoutGrid, Wand2, RefreshCw, ArrowRight, Check, Plus, Loader2, Share2, AlertTriangle, Send, Clapperboard, Music, Volume2, VolumeX, TrendingUp } from "lucide-react";
import { FaInstagram, FaXTwitter, FaTiktok, FaLinkedin } from "react-icons/fa6";
import type { IconType } from "react-icons";
import { useGetBrands, useGetTemplates, useGetStyleProfiles } from "@workspace/api-client-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TasteReactionChips } from "@/components/TasteReactionChips";
import { useDesignerPersonas, type DesignerPersona } from "@/components/DesignersTab";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  // Goal-aware posting: the strategic intent this concept serves.
  intent?: string;
  intentLabel?: string;
}

// Client-side copy of the intent taxonomy labels (source of truth lives on the
// server; this mirror keeps chips rendering without an extra fetch).
const INTENT_LABELS: Record<string, string> = {
  awareness: "Awareness",
  acquisition: "Acquisition",
  community_engagement: "Community engagement",
  recognition_reward: "Recognition & reward",
  announcement_launch: "Announcement / launch",
  education: "Education",
  retention: "Retention",
};
const INTENT_KEYS = Object.keys(INTENT_LABELS);

function intentLabel(intent: string | null | undefined): string | null {
  if (!intent) return null;
  return INTENT_LABELS[intent] || intent.replace(/_/g, " ");
}

// The inference result for the express (free-prompt) path, surfaced as a
// confirm/adjust chip on the Board.
interface IntentInfo {
  intent: string;
  confidence: number | null;
  alternates: { intent: string; confidence?: number }[];
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

// A brand logo available as a compositing overlay (from GET /brands/:id/logos).
interface BrandLogo {
  id: string;
  name: string | null;
  fileUrl: string | null;
  thumbnailUrl: string | null;
  isDefault?: boolean;
}

// The dedicated logo-overlay selector. Logos never act as generation
// references — they are composited onto the finished image — so they get their
// own picker instead of riding along with the reference checkboxes.
function LogoPicker({
  logos,
  value,
  onChange,
  testId = "studio-next-logo",
}: {
  logos: BrandLogo[];
  value: string | null;
  onChange: (v: string | null) => void;
  testId?: string;
}) {
  if (logos.length === 0) return null;
  return (
    <Select value={value ?? "auto"} onValueChange={(v) => onChange(v === "auto" ? null : v)}>
      <SelectTrigger className="w-[220px]" data-testid={testId}>
        <SelectValue placeholder="Auto logo" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">Auto (style/brand default)</SelectItem>
        <SelectItem value="none">No logo</SelectItem>
        {logos.map((l) => (
          <SelectItem key={l.id} value={l.id}>
            {l.name || "Untitled logo"}
            {l.isDefault ? " (brand default)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface StudioState {
  beat: Beat;
  // The creative is created on entering Board; takes/variants hang off it.
  creativeId: string | null;
  brandId: string | null;
  briefText: string;
  selectedConcept: Concept | null;
  // Goal-aware posting: the intent behind this creative — set by picking a
  // concept (each concept carries one) or inferred from the free prompt.
  intent: IntentInfo | null;
  // Confirmed asset picks from the Home beat, persisted onto the creative.
  selectedAssets: SelectedAssetPick[];
  // Design style profile applied to image generation. null = brand default /
  // no style (server falls back to the brand's default profile if one exists).
  styleProfileId: string | null;
  // Designer persona ("Inspired by ...") applied to image generation. null =
  // no persona. Account-scoped, so it survives brand switches conceptually,
  // but we still reset it with the rest of the downstream state for clarity.
  personaId: string | null;
  // How images are produced: "scene" = AI paints the full scene (default);
  // "designed" = multi-layer composited graphic (design-spec → subject cutout
  // → deterministic typographic compositor). Only offered with a persona.
  renderMode: "scene" | "designed";
  // Logo overlaid on the finished images. null = auto (style profile's default
  // logo, then the brand default); "none" = explicitly no logo; otherwise a
  // logo asset id. Persisted onto the creative so regens reuse it.
  logoAssetId: string | null;
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
  | { type: "setIntent"; intent: IntentInfo | null }
  | { type: "setSelectedAssets"; assets: SelectedAssetPick[] }
  | { type: "setStyleProfile"; styleProfileId: string | null }
  | { type: "setPersona"; personaId: string | null }
  | { type: "setRenderMode"; renderMode: "scene" | "designed" }
  | { type: "setLogo"; logoAssetId: string | null }
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
  intent: null,
  selectedAssets: [],
  styleProfileId: null,
  personaId: null,
  renderMode: "scene",
  logoAssetId: null,
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
        intent: null,
        selectedAssets: [],
        styleProfileId: null,
        personaId: null,
        renderMode: "scene",
        logoAssetId: null,
        creativeId: null,
        selectedVariantId: null,
        fanoutApproved: [],
      };
    case "setBrief":
      return { ...state, briefText: action.briefText };
    case "selectConcept":
      // Picking a concept sets the intent it carries; clearing a concept keeps
      // whatever intent was set (the express path infers its own).
      return {
        ...state,
        selectedConcept: action.concept,
        intent: action.concept?.intent
          ? { intent: action.concept.intent, confidence: null, alternates: [] }
          : state.intent,
      };
    case "setIntent":
      return { ...state, intent: action.intent };
    case "setSelectedAssets":
      return { ...state, selectedAssets: action.assets };
    case "setStyleProfile":
      return { ...state, styleProfileId: action.styleProfileId };
    case "setPersona":
      // Dropping the persona also drops designed mode (it's persona-led).
      return {
        ...state,
        personaId: action.personaId,
        renderMode: action.personaId ? state.renderMode : "scene",
      };
    case "setRenderMode":
      return { ...state, renderMode: action.renderMode };
    case "setLogo":
      return { ...state, logoAssetId: action.logoAssetId };
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
  const [logos, setLogos] = useState<BrandLogo[]>([]);
  // Ref mirror so the async matcher can exclude logos without re-memoizing.
  const logoIdsRef = useRef<Set<string>>(new Set());

  const brandId = state.brandId;

  // Brand logos for the dedicated overlay picker (and to keep logos out of the
  // generation-reference suggestions).
  useEffect(() => {
    if (!brandId) {
      setLogos([]);
      logoIdsRef.current = new Set();
      return;
    }
    let cancelled = false;
    void apiFetch(`${API_BASE}/api/brands/${brandId}/logos`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? (data as BrandLogo[]) : [];
        setLogos(list);
        logoIdsRef.current = new Set(list.map((l) => l.id));
      })
      .catch(() => {
        if (!cancelled) {
          setLogos([]);
          logoIdsRef.current = new Set();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  // Default to the first brand once the list loads.
  useEffect(() => {
    if (!brandId && brands && brands.length > 0) {
      dispatch({ type: "setBrand", brandId: brands[0].id });
    }
  }, [brandId, brands, dispatch]);

  // Design style profiles for the active brand. The brand's default profile is
  // preselected; "No style" opts out entirely (unchanged generation behavior).
  const { data: styleProfiles } = useGetStyleProfiles(brandId ?? "", {
    query: { enabled: Boolean(brandId) } as Parameters<typeof useGetStyleProfiles>[1] extends { query?: infer Q } ? Q : never,
  });
  useEffect(() => {
    if (state.styleProfileId || !styleProfiles) return;
    const def = styleProfiles.find((p) => p.isDefault);
    if (def) dispatch({ type: "setStyleProfile", styleProfileId: def.id });
  }, [styleProfiles, state.styleProfileId, dispatch]);

  // Designer personas ("Inspired by...") — account-scoped style inspirations.
  const { personas } = useDesignerPersonas();

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
            // Logos are never generation references — they get the dedicated
            // logo overlay selector instead of a reference checkbox.
            if (logoIdsRef.current.has(a.id) || a.generationRole === "compositing_logo") continue;
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
    dispatch({ type: "setIntent", intent: null });
    // Infer the post's goal from the brief in the background (never blocks the
    // flow); the Board surfaces it as a confirm/adjust chip.
    void postJson(`${API_BASE}/api/intent-inference`, { brandId, briefText: brief.trim() })
      .then((res) => {
        if (res && typeof res.intent === "string") {
          dispatch({
            type: "setIntent",
            intent: {
              intent: res.intent,
              confidence: typeof res.confidence === "number" ? res.confidence : null,
              alternates: Array.isArray(res.alternates) ? res.alternates : [],
            },
          });
        }
      })
      .catch(() => {
        /* inference is best-effort; the chip just won't show */
      });
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
        {logos.length > 0 && (
          <div className="flex items-center gap-3 border-t border-border pt-4">
            <span className="text-sm font-medium text-foreground">Logo overlay</span>
            <LogoPicker
              logos={logos}
              value={state.logoAssetId}
              onChange={(v) => dispatch({ type: "setLogo", logoAssetId: v })}
              testId="asset-picks-logo"
            />
            <span className="text-xs text-muted-foreground">
              Added on top of the finished image — not sent to the AI model.
            </span>
          </div>
        )}
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
        {styleProfiles && styleProfiles.length > 0 && (
          <>
            <span className="text-sm text-muted-foreground">in style</span>
            <Select
              value={state.styleProfileId ?? "none"}
              onValueChange={(v) =>
                dispatch({ type: "setStyleProfile", styleProfileId: v === "none" ? null : v })
              }
            >
              <SelectTrigger className="w-[220px]" data-testid="studio-next-style-profile">
                <SelectValue placeholder="No style" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No style</SelectItem>
                {styleProfiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.isDefault ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        {personas.length > 0 && (
          <>
            <span className="text-sm text-muted-foreground">inspired by</span>
            <Select
              value={state.personaId ?? "none"}
              onValueChange={(v) =>
                dispatch({ type: "setPersona", personaId: v === "none" ? null : v })
              }
            >
              <SelectTrigger className="w-[220px]" data-testid="studio-next-persona">
                <SelectValue placeholder="No designer" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No designer</SelectItem>
                {personas.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        {state.personaId && (
          <label
            className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none"
            data-testid="studio-next-render-mode"
          >
            <Switch
              checked={state.renderMode === "designed"}
              onCheckedChange={(on) =>
                dispatch({ type: "setRenderMode", renderMode: on ? "designed" : "scene" })
              }
              data-testid="studio-next-designed-toggle"
            />
            Designed graphic
          </label>
        )}
        {logos.length > 0 && (
          <>
            <span className="text-sm text-muted-foreground">logo</span>
            <LogoPicker
              logos={logos}
              value={state.logoAssetId}
              onChange={(v) => dispatch({ type: "setLogo", logoAssetId: v })}
            />
          </>
        )}
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
                  <div className="space-y-1.5">
                    {concept.intent && (
                      <span
                        className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-medium"
                        data-testid={`concept-intent-${concept.id}`}
                      >
                        {concept.intentLabel || intentLabel(concept.intent)}
                      </span>
                    )}
                    <h3 className="font-display font-semibold text-foreground leading-snug">
                      {concept.title}
                    </h3>
                  </div>
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
  // Designer-persona compare mode: which persona produced this take (if any),
  // plus the display name the compare endpoint attaches for labeling.
  personaId?: string | null;
  personaName?: string;
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

// --- Influences preview -----------------------------------------------------
// Shows exactly which subject references, style references, and logo will
// influence the next generation, with one-tap remove/swap and a simple
// subject-vs-style balance control. Overrides persist on the creative so
// takes/vary/regenerate all honor them.
interface InfluenceAssetView {
  assetId: string | null;
  name: string;
  thumbnailUrl: string | null;
  role?: string;
  pinned?: boolean;
}

interface InfluencesView {
  balance: "subject" | "balanced" | "style";
  styleProfile: { id: string; name: string } | null;
  // Designer persona with guaranteed reference slots (null when none selected).
  persona: { id: string; name: string; references: Array<{ url: string; label: string | null }> } | null;
  subjects: InfluenceAssetView[];
  styles: InfluenceAssetView[];
  descriptors: InfluenceAssetView[];
  logo: InfluenceAssetView | null;
  pool: InfluenceAssetView[];
  removedAssetIds: string[];
  pinnedAssetIds: string[];
  strategy: string;
}

const BALANCE_OPTIONS: Array<{ value: InfluencesView["balance"]; label: string }> = [
  { value: "subject", label: "Match subject" },
  { value: "balanced", label: "Balanced" },
  { value: "style", label: "Match style" },
];

function InfluenceThumb({
  item,
  label,
  onRemove,
  onSwap,
  swapOptions,
}: {
  item: InfluenceAssetView;
  label: string;
  onRemove?: () => void;
  onSwap?: (assetId: string) => void;
  swapOptions?: InfluenceAssetView[];
}) {
  const [swapOpen, setSwapOpen] = useState(false);
  return (
    <div className="relative group w-[74px]" data-testid={`influence-${item.assetId || "logo"}`}>
      <div className="w-[74px] h-[74px] rounded-lg overflow-hidden border border-border bg-muted/40 flex items-center justify-center">
        {item.thumbnailUrl ? (
          <img src={`${API_BASE}${item.thumbnailUrl}`} alt={item.name} className="w-full h-full object-cover" />
        ) : (
          <Sparkles size={16} className="text-muted-foreground" />
        )}
      </div>
      {onRemove && (
        <button
          className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-5 h-5 rounded-full bg-foreground text-background text-[10px] shadow"
          onClick={onRemove}
          title={`Remove ${item.name}`}
          data-testid={`influence-remove-${item.assetId}`}
        >
          ✕
        </button>
      )}
      <div className="mt-1 space-y-0.5">
        <div className="text-[10px] leading-tight text-foreground truncate" title={item.name}>{item.name}</div>
        <div className="text-[9px] text-muted-foreground">{label}{item.pinned ? " · pinned" : ""}</div>
        {onSwap && swapOptions && swapOptions.length > 0 && (
          <div className="relative">
            <button
              className="text-[9px] text-primary underline hidden group-hover:inline"
              onClick={() => setSwapOpen((o) => !o)}
              data-testid={`influence-swap-${item.assetId}`}
            >
              Swap
            </button>
            {swapOpen && (
              <div className="absolute z-30 mt-1 w-52 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover shadow-md py-1">
                {swapOptions.map((opt) => (
                  <button
                    key={opt.assetId}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-[11px] text-foreground hover:bg-muted"
                    onClick={() => {
                      setSwapOpen(false);
                      if (opt.assetId) onSwap(opt.assetId);
                    }}
                    data-testid={`influence-swap-option-${opt.assetId}`}
                  >
                    {opt.thumbnailUrl ? (
                      <img src={`${API_BASE}${opt.thumbnailUrl}`} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
                    ) : (
                      <span className="w-6 h-6 rounded bg-muted shrink-0" />
                    )}
                    <span className="truncate">{opt.name}</span>
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

function InfluencesPanel({ creativeId, onChanged }: { creativeId: string; onChanged?: () => void }) {
  const { toast } = useToast();
  const [influences, setInfluences] = useState<InfluencesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/influences`);
      if (resp.ok) setInfluences(await resp.json());
    } catch {
      // Non-fatal: the panel simply stays hidden.
    } finally {
      setLoading(false);
    }
  }, [creativeId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function persist(update: Record<string, unknown>) {
    setSaving(true);
    try {
      await putJson(`${API_BASE}/api/creatives/${creativeId}`, update);
      await load();
      onChanged?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Could not update influences", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setSaving(false);
    }
  }

  if (loading || !influences) return null;
  const hasAny = influences.subjects.length > 0 || influences.styles.length > 0 || influences.logo || influences.persona;
  if (!hasAny) return null;

  const overrides = {
    removedAssetIds: influences.removedAssetIds,
    pinnedAssetIds: influences.pinnedAssetIds,
  };

  function removeAsset(assetId: string | null) {
    if (!assetId) return;
    void persist({
      referenceOverrides: {
        removedAssetIds: [...new Set([...overrides.removedAssetIds, assetId])],
        pinnedAssetIds: overrides.pinnedAssetIds.filter((id) => id !== assetId),
      },
    });
  }

  function swapAsset(oldId: string | null, newId: string) {
    void persist({
      referenceOverrides: {
        removedAssetIds: oldId
          ? [...new Set([...overrides.removedAssetIds.filter((id) => id !== newId), oldId])]
          : overrides.removedAssetIds.filter((id) => id !== newId),
        pinnedAssetIds: [...new Set([...overrides.pinnedAssetIds.filter((id) => id !== oldId), newId])],
      },
    });
  }

  const subjectPool = influences.pool.filter((p) => p.role === "subject_reference");
  const stylePool = influences.pool.filter((p) => p.role === "style_reference");

  return (
    <Card className="p-4 space-y-3" data-testid="influences-panel">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="space-y-0.5">
          <div className="text-sm font-medium text-foreground">Influences</div>
          <p className="text-xs text-muted-foreground">
            What the next generation will reference.
            {influences.styleProfile ? ` Style: ${influences.styleProfile.name}.` : ""}
            {influences.persona ? ` Designer: ${influences.persona.name}.` : ""}
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-border overflow-hidden" data-testid="balance-control">
          {BALANCE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={cn(
                "px-2.5 py-1 text-xs",
                influences.balance === opt.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
              disabled={saving}
              onClick={() => influences.balance !== opt.value && void persist({ referenceBalance: opt.value })}
              data-testid={`balance-${opt.value}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-start gap-3 flex-wrap">
        {influences.subjects.map((item) => (
          <InfluenceThumb
            key={item.assetId}
            item={item}
            label="Subject"
            onRemove={() => removeAsset(item.assetId)}
            onSwap={(newId) => swapAsset(item.assetId, newId)}
            swapOptions={subjectPool}
          />
        ))}
        {influences.styles.map((item) => (
          <InfluenceThumb
            key={item.assetId}
            item={item}
            label="Style"
            onRemove={() => removeAsset(item.assetId)}
            onSwap={(newId) => swapAsset(item.assetId, newId)}
            swapOptions={stylePool}
          />
        ))}
        {influences.persona &&
          influences.persona.references.map((ref, i) => (
            <div key={`persona-${i}`} className="w-20 shrink-0" data-testid={`influence-persona-${i}`}>
              <img
                src={`${API_BASE}${ref.url}`}
                alt={ref.label || influences.persona?.name || "Designer reference"}
                className="w-20 h-20 rounded-lg object-cover border border-border"
              />
              <div className="mt-1 space-y-0.5">
                <div className="text-[10px] leading-tight text-foreground truncate" title={ref.label || influences.persona?.name}>
                  {ref.label || influences.persona?.name}
                </div>
                <div className="text-[9px] text-muted-foreground">Designer · guaranteed</div>
              </div>
            </div>
          ))}
        {influences.logo && <InfluenceThumb item={influences.logo} label="Logo" />}
      </div>
      {influences.descriptors.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Also described to the model: {influences.descriptors.map((d) => d.name).join(", ")}
        </p>
      )}
    </Card>
  );
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
  const [compareOpen, setCompareOpen] = useState(false);
  const [usedAssets, setUsedAssets] = useState<UsedAssetChip[]>([]);
  const startedRef = useRef(false);
  // Performance-aware recommendations for the confirmed/inferred goal.
  const insights = useIntentInsights(state.brandId, state.intent?.intent);

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
          // Goal-aware posting: persist the concept-selected or inferred intent.
          intent: state.intent?.intent || undefined,
          styleProfileId: state.styleProfileId || undefined,
          personaId: state.personaId || undefined,
          renderMode: state.renderMode,
          // "none" is a real choice (no logo); null/auto is simply omitted.
          selectedLogoAssetId: state.logoAssetId || undefined,
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
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-semibold text-foreground">Board</h1>
            <IntentChip state={state} dispatch={dispatch} />
          </div>
          <p className="text-sm text-muted-foreground">
            Explore takes of your concept. Vary any take to branch a new direction.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={moreTakes} disabled={working || moreLoading || !state.creativeId}>
            {moreLoading ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Plus size={14} className="mr-1.5" />}
            More takes
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCompareOpen(true)}
            disabled={working || !state.creativeId}
            data-testid="board-compare-designers"
          >
            <Wand2 size={14} className="mr-1.5" />
            Compare designers
          </Button>
          <Button size="sm" onClick={onAdvance} disabled={!state.selectedVariantId} data-testid="board-to-finish">
            To Finish
            <ArrowRight size={16} className="ml-1.5" />
          </Button>
        </div>
      </div>

      <InsightsPanel insights={insights} />

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

      {state.creativeId && <InfluencesPanel creativeId={state.creativeId} />}

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
              creativeId={state.creativeId ?? ""}
              selected={state.selectedVariantId === take.id}
              varying={varyingId === take.id}
              onSelect={() => dispatch({ type: "selectVariant", variantId: take.id })}
              onVary={(mode) => vary(take, mode)}
              onRegenerate={() => regenerateTake(take)}
            />
          ))}
        </div>
      )}

      {state.creativeId && (
        <CompareDesignersDialog
          open={compareOpen}
          onOpenChange={setCompareOpen}
          creativeId={state.creativeId}
          onKeepWinner={(winner) => {
            setTakes((prev) => [...prev, winner]);
            dispatch({ type: "selectVariant", variantId: winner.id });
            setCompareOpen(false);
          }}
        />
      )}
    </div>
  );
}

// --- Designer compare mode ---
// Run the same brief through 2-3 designer personas side by side. Each take is
// a full image generation, so we warn about the N× cost up front. The winner
// joins the board (and gets selected); the other takes stay archived on the
// creative but off the board.
function CompareDesignersDialog({
  open,
  onOpenChange,
  creativeId,
  onKeepWinner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creativeId: string;
  onKeepWinner: (winner: BoardVariant) => void;
}) {
  const { toast } = useToast();
  const { personas, isLoading } = useDesignerPersonas();
  const [picked, setPicked] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BoardVariant[] | null>(null);

  useEffect(() => {
    if (!open) {
      setPicked([]);
      setResults(null);
      setRunning(false);
    }
  }, [open]);

  const toggle = (id: string) => {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : prev.length >= 3 ? prev : [...prev, id]
    );
  };

  const run = async () => {
    if (picked.length < 2) return;
    setRunning(true);
    try {
      const res = await postJson(`${API_BASE}/api/creatives/${creativeId}/compare-takes`, {
        personaIds: picked,
      });
      setResults((res.takes || []) as BoardVariant[]);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Compare failed",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Compare designers</DialogTitle>
          <DialogDescription>
            Run this brief through 2-3 designer styles side by side, then keep the winner.
          </DialogDescription>
        </DialogHeader>

        {results === null ? (
          <>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
                <Loader2 size={14} className="animate-spin" /> Loading designers...
              </div>
            ) : personas.length < 2 ? (
              <p className="text-sm text-muted-foreground py-4">
                You need at least two designers to compare. Add them in Settings → Designers.
              </p>
            ) : (
              <div className="space-y-2">
                {personas.map((p: DesignerPersona) => (
                  <label
                    key={p.id}
                    className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={picked.includes(p.id)}
                      onCheckedChange={() => toggle(p.id)}
                      disabled={running || (!picked.includes(p.id) && picked.length >= 3)}
                      data-testid={`compare-persona-${p.id}`}
                    />
                    <span>
                      <span className="text-sm font-medium text-foreground">Inspired by {p.name}</span>
                      {p.description && (
                        <span className="block text-xs text-muted-foreground">{p.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {picked.length >= 2 && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>
                  {picked.length} designers = {picked.length}× generation cost. Each designer take is a
                  full image generation.
                </span>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
                Cancel
              </Button>
              <Button onClick={run} disabled={running || picked.length < 2} data-testid="compare-run">
                {running ? (
                  <>
                    <Loader2 size={14} className="mr-1.5 animate-spin" /> Generating {picked.length} takes...
                  </>
                ) : (
                  <>Generate {picked.length >= 2 ? `${picked.length} takes` : "takes"}</>
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              {results.map((take) => (
                <div key={take.id} className="space-y-2" data-testid={`compare-result-${take.id}`}>
                  <div className="aspect-square w-full overflow-hidden rounded-lg border border-border bg-muted">
                    {take.compositedImageUrl || take.rawImageUrl ? (
                      <img
                        src={`${API_BASE}${take.compositedImageUrl || take.rawImageUrl}`}
                        alt={take.personaName ? `Inspired by ${take.personaName}` : "Compare take"}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        No image
                      </div>
                    )}
                  </div>
                  <p className="text-xs font-medium text-foreground text-center">
                    {take.personaName ? `Inspired by ${take.personaName}` : "Take"}
                  </p>
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => onKeepWinner(take)}
                    data-testid={`compare-keep-${take.id}`}
                  >
                    <Check size={14} className="mr-1.5" /> Keep this one
                  </Button>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close without keeping
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Goal-aware posting: one-tap confirm/adjust chip for the creative's intent.
// Shows the inferred/selected goal (with confidence when inferred); tapping it
// opens the alternates so the creator can adjust. Adjusting persists onto the
// creative so generation and calendar entries pick it up.
function IntentChip({ state, dispatch }: { state: StudioState; dispatch: Dispatch<StudioAction> }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const info = state.intent;
  if (!info) return null;

  async function choose(intent: string) {
    setOpen(false);
    setConfirmed(true);
    const prev = info;
    dispatch({ type: "setIntent", intent: { intent, confidence: null, alternates: [] } });
    if (state.creativeId && intent !== prev?.intent) {
      try {
        await putJson(`${API_BASE}/api/creatives/${state.creativeId}`, { intent });
        toast({ title: `Goal set to ${intentLabel(intent)}` });
      } catch (err) {
        dispatch({ type: "setIntent", intent: prev });
        setConfirmed(false);
        toast({ variant: "destructive", title: "Could not update goal", description: err instanceof Error ? err.message : "Please try again." });
      }
    }
  }

  const pct = info.confidence != null ? Math.round(info.confidence * 100) : null;
  // Adjust list: the alternates first, then any remaining taxonomy entries.
  const options = [
    ...info.alternates.map((a) => a.intent),
    ...INTENT_KEYS.filter((k) => k !== info.intent && !info.alternates.some((a) => a.intent === k)),
  ];

  return (
    <div className="relative">
      <div className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium overflow-hidden" data-testid="intent-chip">
        <button
          className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 hover:bg-primary/15"
          onClick={() => setOpen((o) => !o)}
          data-testid="intent-chip-adjust"
          title="Adjust the goal for this post"
        >
          <span>Goal · {intentLabel(info.intent)}</span>
          {pct != null && !confirmed && <span className="text-primary/70">{pct}%</span>}
        </button>
        {!confirmed && (
          <button
            className="px-1.5 py-1 border-l border-primary/20 hover:bg-primary/15"
            onClick={() => void choose(info!.intent)}
            data-testid="intent-chip-confirm"
            title="Confirm this goal"
          >
            <Check size={12} />
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-56 rounded-lg border border-border bg-popover shadow-md py-1" data-testid="intent-chip-menu">
          {options.map((k) => (
            <button
              key={k}
              className="w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-muted"
              onClick={() => void choose(k)}
              data-testid={`intent-option-${k}`}
            >
              {intentLabel(k)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Performance-aware recommendations ---
// Data-backed guidance from the insights service: which platforms and posting
// times have worked for this intent, plus reference posts. Degrades honestly —
// with little or no data the server says so and the panel reflects it.

interface InsightPlatform {
  platform: string;
  posts: number;
  avgEngagement: number;
  emphasis: number;
}

interface InsightTime {
  dayPart: string;
  dayPartLabel: string;
  suggestedHour: number;
  posts: number;
  avgEngagement: number;
}

interface InsightRefPost {
  calendarEntryId: string;
  creativeName: string;
  platform: string;
  engagements: number;
}

interface IntentInsights {
  intent: string | null;
  intentLabel: string | null;
  sampleSize: number;
  confidence: "none" | "low" | "medium" | "high";
  platforms: InsightPlatform[];
  bestTimes: InsightTime[];
  topPosts: InsightRefPost[];
  reasoning: string[];
}

// Fetches recommendations for a brand+intent; refetches when either changes.
function useIntentInsights(brandId: string | null, intent: string | null | undefined): IntentInsights | null {
  const [insights, setInsights] = useState<IntentInsights | null>(null);
  useEffect(() => {
    if (!intent) {
      setInsights(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ intent });
    if (brandId) params.set("brandId", brandId);
    void apiFetch(`${API_BASE}/api/insights/recommendations?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setInsights(data as IntentInsights);
      })
      .catch(() => {
        /* recommendations are best-effort; panel just won't show */
      });
    return () => {
      cancelled = true;
    };
  }, [brandId, intent]);
  return insights;
}

// "9am" / "6pm" formatting for suggested schedule hours.
function formatHour(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${hour < 12 ? "am" : "pm"}`;
}

const FANOUT_PLATFORM_LABELS: Record<string, string> = {
  twitter: "X",
  instagram_feed: "Instagram Feed",
  instagram_story: "Instagram Story",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
};

// Compact "what's worked" panel shown on the Board after the intent is known.
function InsightsPanel({ insights }: { insights: IntentInsights | null }) {
  if (!insights) return null;
  const lowData = insights.confidence === "none" || insights.confidence === "low";
  return (
    <Card className="p-4 space-y-2 border-primary/20 bg-primary/[0.03]" data-testid="insights-panel">
      <div className="flex items-center gap-2">
        <TrendingUp size={15} className="text-primary" />
        <h3 className="text-sm font-semibold text-foreground">
          What's worked for {insights.intentLabel ? insights.intentLabel.toLowerCase() : "this goal"}
        </h3>
        {insights.sampleSize > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {insights.sampleSize} tracked {insights.sampleSize === 1 ? "post" : "posts"} ·{" "}
            {insights.confidence} confidence
          </span>
        )}
      </div>
      {insights.reasoning.map((line, i) => (
        <p key={i} className={cn("text-xs", lowData && i === 0 ? "text-amber-500" : "text-muted-foreground")}>
          {line}
        </p>
      ))}
      {insights.topPosts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="text-[11px] text-muted-foreground">Reference posts:</span>
          {insights.topPosts.slice(0, 3).map((p) => (
            <span
              key={p.calendarEntryId}
              className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-foreground"
            >
              {p.creativeName} · {FANOUT_PLATFORM_LABELS[p.platform] || p.platform} · {p.engagements} eng.
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

// Read-only badge showing the creative's goal on Finish and Fan-out.
function IntentBadge({ intent }: { intent: string | null | undefined }) {
  if (!intent) return null;
  return (
    <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2.5 py-0.5 text-xs font-medium" data-testid="intent-badge">
      Goal · {intentLabel(intent)}
    </span>
  );
}

function VariantCard({
  take,
  creativeId,
  selected,
  varying,
  onSelect,
  onVary,
  onRegenerate,
}: {
  take: BoardVariant;
  creativeId: string;
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
      {creativeId && (
        <div className="px-2 pb-2">
          <TasteReactionChips creativeId={creativeId} variantId={take.id} target="take" />
        </div>
      )}
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
  const [renderingHeadline, setRenderingHeadline] = useState(false);
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

  // mode "instant" — free design-aware overlay recomposite.
  // mode "render"  — the image model paints the headline into the scene
  //                  (verified for spelling/legibility, falls back to overlay).
  async function applyHeadline(mode: "instant" | "render") {
    if (!variant || !state.creativeId || !headline.trim()) return;
    if (mode === "render") setRenderingHeadline(true);
    else setSavingHeadline(true);
    try {
      const updated = await putJson(`${API_BASE}/api/creatives/${state.creativeId}/variants/${variant.id}/headline`, { headline: headline.trim(), mode });
      setVariant(updated as BoardVariant);
      // Headline recomposite may reuse the same image path — bump to bust the cache.
      setImgV((v) => v + 1);
      const fallback = (updated as { renderFallback?: string | null }).renderFallback;
      if (fallback) {
        toast({ title: "Headline applied as overlay", description: fallback });
      } else {
        toast({ title: mode === "render" ? "Headline rendered into the image" : "Headline updated" });
      }
    } catch (err) {
      toast({ variant: "destructive", title: "Update failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      if (mode === "render") setRenderingHeadline(false);
      else setSavingHeadline(false);
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
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-semibold text-foreground">Finish</h1>
            <IntentBadge intent={state.intent?.intent} />
          </div>
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
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => applyHeadline("instant")} disabled={savingHeadline || renderingHeadline || !headline.trim()}>
              {savingHeadline && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              Instant edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => applyHeadline("render")} disabled={savingHeadline || renderingHeadline || !headline.trim()} data-testid="finish-headline-render">
              {renderingHeadline && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              Render into image
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Instant edit overlays the text for free. Render into image asks the model to paint the headline into the scene (spell-checked, a moment slower).
          </p>
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
  // Performance-aware fan-out: platform emphasis + suggested schedule times
  // derived from this goal's engagement history.
  const insights = useIntentInsights(state.brandId, state.intent?.intent);
  const bestTime = insights?.bestTimes?.[0];
  // Suggested schedule hour from the best-performing day-part; only trusted
  // beyond "low" confidence — otherwise the default (9am) stands.
  const suggestedHour =
    insights && bestTime && insights.confidence !== "none" && insights.confidence !== "low"
      ? bestTime.suggestedHour
      : null;
  const recommendedPlatforms = useMemo(() => {
    if (!insights || insights.sampleSize === 0) return new Set<string>();
    return new Set(
      insights.platforms.filter((p) => p.emphasis >= 0.6 && p.avgEngagement > 0).map((p) => p.platform),
    );
  }, [insights]);

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
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-semibold text-foreground">Make platform set</h1>
            <IntentBadge intent={state.intent?.intent} />
          </div>
          <p className="text-sm text-muted-foreground">
            Reframe your winning take to each platform, with a caption tuned per channel. No regeneration.
          </p>
        </div>
        {!state.selectedVariantId ? (
          <p className="text-muted-foreground">Pick and finish a take first.</p>
        ) : (
          <>
            {insights && (
              <div
                className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3 space-y-1"
                data-testid="fanout-insights"
              >
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <TrendingUp size={13} className="text-primary" />
                  Based on your results
                </div>
                {insights.reasoning.map((line, i) => (
                  <p key={i} className="text-xs text-muted-foreground">{line}</p>
                ))}
                {suggestedHour !== null && bestTime && (
                  <p className="text-xs text-muted-foreground">
                    Scheduling will suggest {bestTime.dayPartLabel.split(" (")[0]} ({formatHour(suggestedHour)}) — your
                    best-performing window. You confirm every time before it posts.
                  </p>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {FANOUT_PLATFORMS.map((p) => {
                const on = selected.has(p.key);
                const recommended = recommendedPlatforms.has(p.key);
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
                      {recommended && (
                        <span className="ml-1.5 inline-flex items-center rounded-full bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-medium align-middle">
                          top performer
                        </span>
                      )}
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
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-semibold text-foreground">Platform set</h1>
            <IntentBadge intent={state.intent?.intent} />
          </div>
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
            suggestedHour={suggestedHour}
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
  suggestedHour,
  selectedForApprove,
  onToggleApprove,
  onPatched,
}: {
  variant: BoardVariant;
  creativeId: string;
  // Data-backed suggested schedule hour (null = no confident insight; the
  // 9am default applies). The user still confirms on the Calendar.
  suggestedHour: number | null;
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

  // Send tail: schedule this approved variant. Defaults to tomorrow 9am, or the
  // data-backed suggested hour when engagement history supports one. Always
  // adjustable/confirmable on the Calendar — never auto-posts.
  async function schedule() {
    setScheduling(true);
    try {
      const hour = suggestedHour ?? 9;
      const when = new Date();
      when.setDate(when.getDate() + 1);
      when.setHours(hour, 0, 0, 0);
      await postJson(`${API_BASE}/api/calendar-entries`, {
        creativeId,
        variantId: variant.id,
        platform: variant.platform,
        scheduledAt: when.toISOString(),
      });
      setScheduled(true);
      toast({
        title: "Added to Calendar",
        description: suggestedHour !== null
          ? `Scheduled for tomorrow ${formatHour(hour)} — your best-performing window. Adjust or publish on the Calendar.`
          : "Scheduled for tomorrow 9am. Adjust or publish on the Calendar.",
      });
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

        <TasteReactionChips creativeId={creativeId} variantId={variant.id} target="variant" />

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
