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
import { Palette, Save, Loader2, Plus, X, Wand2, Sparkles, Check, Link2, Trash2, LayoutTemplate } from "lucide-react";
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
