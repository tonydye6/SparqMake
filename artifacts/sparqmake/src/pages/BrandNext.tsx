import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetBrands, getGetBrandsQueryKey, useGetAssets, useGetTemplates, useGetSocialAccounts } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Palette, Save, Loader2, Plus, X, Wand2, Sparkles, Check, Link2, Trash2, LayoutTemplate, Brain, RefreshCw } from "lucide-react";
import { FaInstagram, FaXTwitter, FaTiktok, FaLinkedin, FaYoutube } from "react-icons/fa6";
import type { IconType } from "react-icons";

const API_BASE = import.meta.env.VITE_API_URL || "";

// List endpoints are inconsistently a bare array or a { data: [] } wrapper.
function toArray<T>(resp: unknown): T[] {
  if (Array.isArray(resp)) return resp as T[];
  if (resp && typeof resp === "object" && Array.isArray((resp as { data?: unknown }).data)) {
    return (resp as { data: T[] }).data;
  }
  return [];
}

const PLATFORM_ICONS: Record<string, IconType> = {
  instagram: FaInstagram,
  twitter: FaXTwitter,
  x: FaXTwitter,
  tiktok: FaTiktok,
  linkedin: FaLinkedin,
  youtube: FaYoutube,
};

const CONNECTABLE_PLATFORMS: { key: string; label: string }[] = [
  { key: "instagram", label: "Instagram" },
  { key: "twitter", label: "X" },
  { key: "tiktok", label: "TikTok" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "youtube", label: "YouTube" },
];

// The transparent, editable brand spec (N3). Mirrors the brands table; the Brand
// page edits it as structured fields and saves via PUT /brands/:id (full update).
interface BrandSpec {
  id: string;
  name: string;
  slug: string;
  colorPrimary: string;
  colorSecondary: string;
  colorAccent: string;
  colorBackground: string;
  voiceDescription: string;
  voiceExamples?: string[];
  bannedTerms: string[];
  trademarkRules: string;
  characterStyleRules: string;
  imagenPrefix: string;
  negativePrompt: string;
  hashtagStrategy?: unknown;
  platformRules?: unknown;
  logoFileUrl?: string | null;
  brandFonts?: unknown;
  brandAssetConfig?: unknown;
  isActive?: boolean;
}

export default function BrandNext() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: brands, isLoading } = useGetBrands();
  const [activeBrandId, setActiveBrandId] = useState<string>("");
  const [draft, setDraft] = useState<BrandSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [seedText, setSeedText] = useState("");
  const [seeding, setSeeding] = useState(false);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);

  const { data: assetsData, refetch: refetchAssets } = useGetAssets(activeBrandId ? { brandId: activeBrandId } : undefined);
  const { data: templatesData } = useGetTemplates(activeBrandId ? { brandId: activeBrandId } : undefined);
  const { data: socialData, refetch: refetchSocial } = useGetSocialAccounts();

  const list = (brands ?? []) as unknown as BrandSpec[];
  const assets = toArray<{ id: string; name: string; type?: string; status?: string; assetClass?: string | null; thumbnailUrl?: string | null }>(assetsData);
  const templates = toArray<{ id: string; name: string; description?: string | null; totalGenerations?: number; isActive?: boolean }>(templatesData);
  const accounts = toArray<{ id: string; platform: string; accountName?: string; displayStatus?: string; status?: string; brandId?: string }>(socialData)
    .filter((a) => !a.brandId || a.brandId === activeBrandId);

  // Default to the first brand once the list loads.
  useEffect(() => {
    if (!activeBrandId && list.length > 0) setActiveBrandId(list[0].id);
  }, [activeBrandId, list]);

  // (Re)load the editable draft when the active brand changes or the list refetches.
  useEffect(() => {
    const b = list.find((x) => x.id === activeBrandId);
    if (b) setDraft({ ...b });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBrandId, brands]);

  function set<K extends keyof BrandSpec>(key: K, value: BrandSpec[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/brands/${draft.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || e.message || `Save failed (${resp.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: getGetBrandsQueryKey() });
      toast({ title: "Brand saved" });
    } catch (err) {
      toast({ variant: "destructive", title: "Save failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setSaving(false);
    }
  }

  // Dual-path editing: describe a change in natural language; the agent proposes
  // structured field changes, merged into the draft for review (not auto-saved).
  async function askAgent() {
    if (!draft || !instruction.trim()) return;
    setAssisting(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/brands/${draft.id}/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: instruction.trim() }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || data.message || `Assist failed (${resp.status})`);
      const proposal = (data.proposal || {}) as Partial<BrandSpec>;
      const changed = Object.keys(proposal);
      if (changed.length === 0) {
        toast({ title: "No changes proposed", description: "Try rephrasing the instruction." });
        return;
      }
      setDraft((d) => (d ? { ...d, ...proposal } : d));
      setInstruction("");
      toast({ title: "Changes proposed", description: `Updated ${changed.join(", ")}. Review and Save.` });
    } catch (err) {
      toast({ variant: "destructive", title: "Agent edit failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setAssisting(false);
    }
  }

  // Auto-seed: draft a first-pass spec from the brand's uploaded context docs plus
  // any pasted text. Merged into the draft for review (confirm/correct), not saved.
  async function seedBrand() {
    if (!draft) return;
    setSeeding(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/brands/${draft.id}/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceText: seedText.trim() || undefined }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || data.message || `Seed failed (${resp.status})`);
      const proposal = (data.proposal || {}) as Partial<BrandSpec>;
      const changed = Object.keys(proposal);
      if (changed.length === 0) {
        toast({ title: "Nothing to draft", description: "Add more source material." });
        return;
      }
      setDraft((d) => (d ? { ...d, ...proposal } : d));
      setSeedText("");
      const src = typeof data.sources === "number" && data.sources > 0 ? ` (used ${data.sources} brand doc${data.sources === 1 ? "" : "s"})` : "";
      toast({ title: "Draft ready", description: `Drafted ${changed.length} field${changed.length === 1 ? "" : "s"}${src}. Review and Save.` });
    } catch (err) {
      toast({ variant: "destructive", title: "Seed failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setSeeding(false);
    }
  }

  async function approveAsset(id: string) {
    setBusyAssetId(id);
    try {
      const resp = await apiFetch(`${API_BASE}/api/assets/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || e.message || `Failed (${resp.status})`);
      }
      await refetchAssets();
    } catch (err) {
      toast({ variant: "destructive", title: "Approve failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setBusyAssetId(null);
    }
  }

  function connectPlatform(platform: string) {
    if (!activeBrandId) return;
    window.location.href = `${API_BASE}/api/auth/${platform}?brandId=${activeBrandId}`;
  }

  async function disconnectAccount(id: string) {
    try {
      const resp = await apiFetch(`${API_BASE}/api/social-accounts/${id}`, { method: "DELETE" });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || e.message || `Failed (${resp.status})`);
      }
      await refetchSocial();
      toast({ title: "Disconnected" });
    } catch (err) {
      toast({ variant: "destructive", title: "Disconnect failed", description: err instanceof Error ? err.message : "Please try again." });
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header: brand switcher + save */}
      <div className="h-16 border-b border-border flex items-center gap-3 px-6 shrink-0">
        <Palette size={18} className="text-primary" />
        <h1 className="font-display text-lg font-semibold text-foreground">Brand</h1>
        <Select value={activeBrandId || undefined} onValueChange={setActiveBrandId} disabled={isLoading || list.length === 0}>
          <SelectTrigger className="w-[220px] ml-2" data-testid="brand-switcher">
            <SelectValue placeholder={isLoading ? "Loading brands" : "Select a brand"} />
          </SelectTrigger>
          <SelectContent>
            {list.map((b) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">Brand · transparent, editable spec</span>
        <Button size="sm" onClick={save} disabled={!draft || saving} data-testid="brand-save">
          {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Save size={14} className="mr-1.5" />}
          Save
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {!draft ? (
          <div className="max-w-2xl mx-auto mt-16 text-center text-muted-foreground">
            {isLoading ? "Loading brand..." : "No brand selected."}
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-6 py-8">
            {/* Dual-path: natural-language editing alongside the structured fields. */}
            <Card className="p-4 mb-6 space-y-2">
              <div className="flex items-center gap-2">
                <Wand2 size={15} className="text-primary" />
                <span className="text-sm font-medium text-foreground">Edit with the agent</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Describe a change in plain language. The agent proposes edits to the fields below for you to review and Save.
              </p>
              <div className="flex gap-2">
                <Input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      askAgent();
                    }
                  }}
                  placeholder="e.g. make the voice punchier and add 'lit' to the never-use list"
                  disabled={assisting}
                  data-testid="brand-assist-input"
                />
                <Button onClick={askAgent} disabled={assisting || !instruction.trim()} data-testid="brand-assist-apply">
                  {assisting ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Wand2 size={14} className="mr-1.5" />}
                  Apply
                </Button>
              </div>
            </Card>

            {/* Auto-seed: draft the spec from uploaded brand docs + optional pasted text. */}
            <Card className="p-4 mb-6 space-y-2">
              <div className="flex items-center gap-2">
                <Sparkles size={15} className="text-primary" />
                <span className="text-sm font-medium text-foreground">Seed from brand docs</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Draft this brand from your uploaded brand documents (and any text below). It fills the fields about 80%, for you to confirm and correct.
              </p>
              <Textarea
                value={seedText}
                onChange={(e) => setSeedText(e.target.value)}
                placeholder="Optional: paste brand-book text, or describe the brand (voice, colors, do/don'ts)..."
                className="min-h-20 resize-none text-sm"
                disabled={seeding}
                data-testid="brand-seed-input"
              />
              <Button variant="outline" size="sm" onClick={seedBrand} disabled={seeding} data-testid="brand-seed-apply">
                {seeding ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Sparkles size={14} className="mr-1.5" />}
                Draft from docs
              </Button>
            </Card>

            <Tabs defaultValue="visual" className="w-full">
              <TabsList>
                <TabsTrigger value="visual">Visual DNA</TabsTrigger>
                <TabsTrigger value="voice">Voice</TabsTrigger>
                <TabsTrigger value="assets">Assets</TabsTrigger>
                <TabsTrigger value="templates">Templates</TabsTrigger>
                <TabsTrigger value="platforms">Platforms</TabsTrigger>
                <TabsTrigger value="taste" data-testid="brand-tab-taste">Taste</TabsTrigger>
              </TabsList>

              {/* Visual DNA */}
              <TabsContent value="visual" className="space-y-6 pt-4">
                <Field label="Brand name">
                  <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
                </Field>

                <div className="space-y-2">
                  <Label>Colors</Label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <ColorField label="Primary" value={draft.colorPrimary} onChange={(v) => set("colorPrimary", v)} />
                    <ColorField label="Secondary" value={draft.colorSecondary} onChange={(v) => set("colorSecondary", v)} />
                    <ColorField label="Accent" value={draft.colorAccent} onChange={(v) => set("colorAccent", v)} />
                    <ColorField label="Background" value={draft.colorBackground} onChange={(v) => set("colorBackground", v)} />
                  </div>
                </div>

                <Field label="Image prompt prefix" hint="Prepended to every image generation for this brand.">
                  <Textarea value={draft.imagenPrefix} onChange={(e) => set("imagenPrefix", e.target.value)} className="min-h-20 resize-none" />
                </Field>
                <Field label="Negative prompt" hint="What image generation should avoid.">
                  <Textarea value={draft.negativePrompt} onChange={(e) => set("negativePrompt", e.target.value)} className="min-h-16 resize-none" />
                </Field>
                <Field label="Character / style rules" hint="Narrative constraints for on-brand characters and style.">
                  <Textarea value={draft.characterStyleRules} onChange={(e) => set("characterStyleRules", e.target.value)} className="min-h-24 resize-none" />
                </Field>
              </TabsContent>

              {/* Voice */}
              <TabsContent value="voice" className="space-y-6 pt-4">
                <Field label="Voice & tone" hint="How this brand sounds. Drives captions across platforms.">
                  <Textarea value={draft.voiceDescription} onChange={(e) => set("voiceDescription", e.target.value)} className="min-h-28 resize-none" />
                </Field>
                <div className="space-y-2">
                  <Label>Voice examples</Label>
                  <p className="text-xs text-muted-foreground">3 to 5 real example posts. The caption model uses these few-shot to match the brand's tone.</p>
                  <div className="space-y-2">
                    {(draft.voiceExamples || []).map((ex, i) => (
                      <div key={i} className="flex gap-2 items-start">
                        <Textarea
                          value={ex}
                          onChange={(e) => {
                            const updated = [...(draft.voiceExamples || [])];
                            updated[i] = e.target.value;
                            set("voiceExamples", updated);
                          }}
                          placeholder={`Example post ${i + 1}`}
                          rows={2}
                          className="resize-none flex-1 text-sm"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mt-1 text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            const updated = (draft.voiceExamples || []).filter((_, j) => j !== i);
                            set("voiceExamples", updated);
                          }}
                        >
                          <X size={14} />
                        </Button>
                      </div>
                    ))}
                    {(draft.voiceExamples || []).length < 5 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-xs"
                        onClick={() => set("voiceExamples", [...(draft.voiceExamples || []), ""])}
                      >
                        <Plus size={13} />
                        Add example
                      </Button>
                    )}
                  </div>
                </div>
                <Field label="Never use" hint="Terms generation must avoid.">
                  <ChipList items={draft.bannedTerms} onChange={(items) => set("bannedTerms", items)} placeholder="Add a banned term" />
                </Field>
                <Field label="Trademark rules" hint="How the brand name and marks must be used.">
                  <Textarea value={draft.trademarkRules} onChange={(e) => set("trademarkRules", e.target.value)} className="min-h-24 resize-none" />
                </Field>
              </TabsContent>

              {/* Assets — brand-scoped 4-class reference taxonomy */}
              <TabsContent value="assets" className="space-y-3 pt-4">
                <p className="text-xs text-muted-foreground">
                  {assets.length} asset{assets.length === 1 ? "" : "s"} · the reference taxonomy (compositing / subject / style / context).
                </p>
                {assets.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No assets yet for this brand.</p>
                ) : (
                  <div className="space-y-2">
                    {assets.map((a) => (
                      <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
                        {a.thumbnailUrl ? (
                          <img src={a.thumbnailUrl} alt="" className="h-10 w-10 rounded object-cover bg-muted shrink-0" />
                        ) : (
                          <div className="h-10 w-10 rounded bg-muted shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground truncate">{a.name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {a.assetClass && <Badge variant="outline" className="text-[10px]">{a.assetClass.replace(/_/g, " ")}</Badge>}
                            <Badge variant={a.status === "approved" ? "default" : "secondary"} className="text-[10px]">{a.status || "uploaded"}</Badge>
                          </div>
                        </div>
                        {a.status !== "approved" && (
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busyAssetId === a.id} onClick={() => approveAsset(a.id)}>
                            {busyAssetId === a.id ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Check size={12} className="mr-1" />}
                            Approve
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Templates — reusable campaign patterns */}
              <TabsContent value="templates" className="space-y-3 pt-4">
                <p className="text-xs text-muted-foreground">
                  {templates.length} reusable campaign template{templates.length === 1 ? "" : "s"}.
                </p>
                {templates.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No templates yet for this brand.</p>
                ) : (
                  <div className="space-y-2">
                    {templates.map((t) => (
                      <div key={t.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
                        <LayoutTemplate size={16} className="text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground truncate">{t.name}</p>
                          {t.description && <p className="text-xs text-muted-foreground truncate">{t.description}</p>}
                        </div>
                        {typeof t.totalGenerations === "number" && (
                          <Badge variant="secondary" className="text-[10px]">{t.totalGenerations} uses</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Platforms — connected social accounts (OAuth) */}
              <TabsContent value="platforms" className="space-y-5 pt-4">
                <div className="space-y-2">
                  <Label>Connected accounts</Label>
                  {accounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No accounts connected for this brand.</p>
                  ) : (
                    accounts.map((acc) => {
                      const Icon = PLATFORM_ICONS[acc.platform];
                      const st = acc.displayStatus || acc.status || "connected";
                      return (
                        <div key={acc.id} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
                          {Icon && <Icon size={18} className="text-foreground shrink-0" />}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-foreground truncate">{acc.accountName || acc.platform}</p>
                            <Badge variant={st === "connected" ? "default" : "secondary"} className="text-[10px] mt-0.5">{st}</Badge>
                          </div>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => disconnectAccount(acc.id)}>
                            <Trash2 size={13} className="mr-1" /> Disconnect
                          </Button>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Connect a platform</Label>
                  <div className="flex flex-wrap gap-2">
                    {CONNECTABLE_PLATFORMS.map((p) => {
                      const Icon = PLATFORM_ICONS[p.key];
                      return (
                        <Button key={p.key} size="sm" variant="outline" onClick={() => connectPlatform(p.key)} disabled={!activeBrandId}>
                          {Icon && <Icon size={14} className="mr-1.5" />}
                          {p.label}
                          <Link2 size={12} className="ml-1.5 text-muted-foreground" />
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </TabsContent>

              {/* Taste — "what we've learned" from the team's decisions */}
              <TabsContent value="taste" className="pt-4">
                <TastePanel brandId={draft.id} />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-foreground">{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-9 rounded border border-border bg-transparent p-0.5 cursor-pointer"
          aria-label={label}
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" />
      </div>
    </div>
  );
}

function ChipList({ items, onChange, placeholder }: { items: string[]; onChange: (items: string[]) => void; placeholder?: string }) {
  const [input, setInput] = useState("");
  function add() {
    const v = input.trim();
    if (!v || items.includes(v)) return;
    onChange([...items, v]);
    setInput("");
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {items.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground">
            {t}
            <button onClick={() => onChange(items.filter((x) => x !== t))} className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${t}`}>
              <X size={12} />
            </button>
          </span>
        ))}
        {items.length === 0 && <span className="text-xs text-muted-foreground">None</span>}
      </div>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="text-sm"
        />
        <Button variant="outline" size="sm" onClick={add} disabled={!input.trim()}>
          <Plus size={14} />
        </Button>
      </div>
    </div>
  );
}

// "What we've learned" panel: the AI-distilled (and editable) taste guidance
// for a brand, with signal counts, a re-learn button, and version history.
function TastePanel({ brandId }: { brandId: string }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [guidance, setGuidance] = useState("");
  const [savedGuidance, setSavedGuidance] = useState("");
  const [version, setVersion] = useState(0);
  const [pendingSignals, setPendingSignals] = useState(0);
  const [totalSignals, setTotalSignals] = useState(0);
  const [versions, setVersions] = useState<{ id: string; version: number; source: string; signalCount: number; createdAt: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [distilling, setDistilling] = useState(false);

  const load = async () => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/brands/${brandId}/taste`);
      if (!resp.ok) throw new Error(`Failed (${resp.status})`);
      const data = await resp.json();
      setGuidance(data.guidance || "");
      setSavedGuidance(data.guidance || "");
      setVersion(data.version || 0);
      setPendingSignals(data.pendingSignals || 0);
      setTotalSignals(data.totalSignals || 0);
      setVersions(Array.isArray(data.versions) ? data.versions : []);
    } catch {
      toast({ variant: "destructive", title: "Could not load taste guidance" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  async function saveGuidance() {
    setSaving(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/brands/${brandId}/taste`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guidance }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `Save failed (${resp.status})`);
      setSavedGuidance(guidance);
      setVersion(data.version ?? version);
      toast({ title: "Taste guidance saved" });
      void load();
    } catch (err) {
      toast({ variant: "destructive", title: "Save failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setSaving(false);
    }
  }

  async function distillNow() {
    setDistilling(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/brands/${brandId}/taste/distill`, { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `Failed (${resp.status})`);
      if (data.distilled) {
        toast({ title: "Learned from recent decisions", description: "The taste guidance was updated." });
        await load();
      } else {
        toast({ title: "Nothing new to learn", description: data.message || "No new decisions since the last update." });
      }
    } catch (err) {
      toast({ variant: "destructive", title: "Learning failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setDistilling(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Loading what we've learned...</p>;
  }

  return (
    <div className="space-y-5">
      <Card className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Brain size={15} className="text-primary" />
          <span className="text-sm font-medium text-foreground">What we've learned</span>
          {version > 0 && <Badge variant="secondary" className="text-[10px]">v{version}</Badge>}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 px-2 text-xs"
            disabled={distilling}
            onClick={distillNow}
            data-testid="taste-distill-now"
          >
            {distilling ? <Loader2 size={12} className="mr-1 animate-spin" /> : <RefreshCw size={12} className="mr-1" />}
            Learn now
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The AI studies every decision your team makes — which takes win, what gets rejected and why, how captions get
          rewritten, and your reaction chips — and turns them into guidance that steers new images and captions.
          {" "}{totalSignals} decision{totalSignals === 1 ? "" : "s"} recorded so far{pendingSignals > 0 ? ` · ${pendingSignals} not yet learned from` : ""}.
        </p>
        <Textarea
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          placeholder="Nothing learned yet. Guidance appears here after your team makes enough decisions — or write your own preferences and save."
          className="min-h-48 resize-y text-sm font-mono"
          data-testid="taste-guidance-input"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={saveGuidance} disabled={saving || guidance === savedGuidance} data-testid="taste-guidance-save">
            {saving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Save size={13} className="mr-1.5" />}
            Save guidance
          </Button>
        </div>
      </Card>

      {versions.length > 0 && (
        <div className="space-y-2">
          <Label>History</Label>
          <div className="space-y-1.5">
            {versions.map((v) => (
              <div key={v.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
                <Badge variant="outline" className="text-[10px]">v{v.version}</Badge>
                <span className="text-foreground">{v.source === "manual" ? "Edited by the team" : `Learned from ${v.signalCount} decision${v.signalCount === 1 ? "" : "s"}`}</span>
                <span className="ml-auto text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
