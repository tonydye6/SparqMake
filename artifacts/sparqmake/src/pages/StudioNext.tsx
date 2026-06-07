import { useReducer, useEffect, useState, useCallback, useRef } from "react";
import type { Dispatch, MouseEvent } from "react";
import { Sparkles, LayoutGrid, Wand2, RefreshCw, ArrowRight, Check, Plus, Loader2, Share2, AlertTriangle, Send } from "lucide-react";
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

// Studio beats: the P1 spine (Home → Board → Finish) plus Fan-out (P2). Send/Brand are P3.
type Beat = "home" | "board" | "finish" | "fanout";

// A named concept card from the Beat 1 ideation endpoint. Ephemeral until the
// creator picks one; the selection then seeds the Board (and is persisted there).
interface Concept {
  id: string;
  title: string;
  angle: string;
}

interface StudioState {
  beat: Beat;
  // The creative is created on entering Board; takes/variants hang off it.
  creativeId: string | null;
  brandId: string | null;
  briefText: string;
  selectedConcept: Concept | null;
  // The take chosen on the Board, carried into Finish.
  selectedVariantId: string | null;
}

type StudioAction =
  | { type: "goto"; beat: Beat }
  | { type: "setBrand"; brandId: string }
  | { type: "setBrief"; briefText: string }
  | { type: "selectConcept"; concept: Concept | null }
  | { type: "setCreative"; creativeId: string }
  | { type: "selectVariant"; variantId: string };

const initialState: StudioState = {
  beat: "home",
  creativeId: null,
  brandId: null,
  briefText: "",
  selectedConcept: null,
  selectedVariantId: null,
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
        creativeId: null,
        selectedVariantId: null,
      };
    case "setBrief":
      return { ...state, briefText: action.briefText };
    case "selectConcept":
      return { ...state, selectedConcept: action.concept };
    case "setCreative":
      return { ...state, creativeId: action.creativeId };
    case "selectVariant":
      return { ...state, selectedVariantId: action.variantId };
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
          return (
            <button
              key={b.id}
              onClick={() => dispatch({ type: "goto", beat: b.id })}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : done
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
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
        {state.beat === "fanout" && <BeatFanout state={state} />}
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

  function pickConcept(concept: Concept) {
    dispatch({ type: "setBrief", briefText: brief.trim() });
    dispatch({ type: "selectConcept", concept });
    onAdvance();
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
    onAdvance();
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
          <Button onClick={generateFromPrompt} disabled={!brandId} data-testid="studio-next-generate">
            Generate
            <ArrowRight size={16} className="ml-1.5" />
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
                  className="p-4 flex flex-col gap-2 cursor-pointer transition-colors hover:border-primary"
                  onClick={() => pickConcept(concept)}
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
  const startedRef = useRef(false);

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
          selectedAssets: [],
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
}: {
  take: BoardVariant;
  selected: boolean;
  varying: boolean;
  onSelect: () => void;
  onVary: (mode: string) => void;
}) {
  const img = take.compositedImageUrl || take.rawImageUrl;
  return (
    <Card
      className={cn(
        "overflow-hidden p-0 transition-colors",
        selected ? "border-primary ring-1 ring-primary" : "hover:border-muted-foreground/40",
      )}
    >
      <button onClick={onSelect} className="relative block w-full aspect-square bg-muted" data-testid={`take-${take.id}`}>
        {img ? (
          <img src={img} alt="Generated take" className="w-full h-full object-cover" />
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
        {VARY_OPTIONS.map((opt) => (
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
        ))}
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
  const startedRef = useRef(false);

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

  const img = variant.compositedImageUrl || variant.rawImageUrl;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 grid gap-8 md:grid-cols-2">
      {/* Finished composite preview */}
      <div className="space-y-2">
        <Card className="overflow-hidden p-0 bg-muted">
          {img ? (
            <img src={img} alt="Finished composite" className="w-full aspect-square object-cover" />
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

function BeatFanout({ state }: { state: StudioState }) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<"select" | "working" | "ready">("select");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(FANOUT_PLATFORMS.map((p) => p.key)));
  const [variants, setVariants] = useState<BoardVariant[]>([]);
  const [approveIds, setApproveIds] = useState<Set<string>>(new Set());
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
    setApproveIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      setApproveIds(new Set());
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
  const img = variant.compositedImageUrl || variant.rawImageUrl;
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
        {img ? (
          <img src={img} alt={`${meta?.group || variant.platform || "platform"} variant`} className="w-full h-full object-cover" />
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
