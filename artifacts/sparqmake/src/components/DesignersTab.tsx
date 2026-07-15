import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, isForbidden, PERMISSION_DENIED_MESSAGE } from "@/lib/utils";
import { Loader2, Palette, Plus, Sparkles, Trash2, Pencil, Link2, ImagePlus } from "lucide-react";

const baseUrl = import.meta.env.VITE_API_URL || "";

export interface PersonaReferenceImage {
  url: string;
  label?: string;
}

export interface DesignerPersona {
  id: string;
  name: string;
  description: string;
  sourceType: string;
  sourceUrl: string | null;
  typography: string;
  composition: string;
  colorPhilosophy: string;
  textureAndEffects: string;
  mood: string;
  referenceImages: PersonaReferenceImage[];
  createdAt?: string;
  updatedAt?: string;
}

interface PersonaFormValues {
  name: string;
  description: string;
  typography: string;
  composition: string;
  colorPhilosophy: string;
  textureAndEffects: string;
  mood: string;
  sourceType: string;
  sourceUrl: string | null;
  referenceImages: PersonaReferenceImage[];
}

const EMPTY_FORM: PersonaFormValues = {
  name: "",
  description: "",
  typography: "",
  composition: "",
  colorPhilosophy: "",
  textureAndEffects: "",
  mood: "",
  sourceType: "manual",
  sourceUrl: null,
  referenceImages: [],
};

const FINGERPRINT_FIELDS: { key: keyof PersonaFormValues; label: string; placeholder: string }[] = [
  { key: "typography", label: "Typography", placeholder: "Typeface tendencies, weights, casing, expressive type moves..." },
  { key: "composition", label: "Composition", placeholder: "Grids, negative space, hierarchy, cropping, signature layouts..." },
  { key: "colorPhilosophy", label: "Color Philosophy", placeholder: "Palette character, saturation strategy, how color creates mood..." },
  { key: "textureAndEffects", label: "Texture & Effects", placeholder: "Grain, gradients, shadows, print artifacts, finishing moves..." },
  { key: "mood", label: "Mood", placeholder: "The emotional register the work projects..." },
];

export function useDesignerPersonas() {
  const [personas, setPersonas] = useState<DesignerPersona[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch(`${baseUrl}/api/designer-personas`);
      if (!res.ok) throw new Error("Failed to load designers");
      const json = await res.json();
      setPersonas(json.data || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load designers");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  return { personas, isLoading, error, reload };
}

function fingerprintSummary(p: DesignerPersona): string {
  const bits = [p.mood, p.colorPhilosophy, p.typography].filter(Boolean);
  const text = bits.join(" · ");
  return text.length > 160 ? text.slice(0, 157) + "..." : text;
}

export default function DesignersTab() {
  const { toast } = useToast();
  const { personas, isLoading, error, reload } = useDesignerPersonas();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DesignerPersona | null>(null);
  const [form, setForm] = useState<PersonaFormValues>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DesignerPersona | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // AI builder state
  const [aiUrl, setAiUrl] = useState("");
  const [aiFiles, setAiFiles] = useState<File[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Work sample upload (edit dialog only): appends images to the persona
  // immediately via the reference-images endpoint, then syncs the form.
  const sampleInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploadingSamples, setIsUploadingSamples] = useState(false);

  const uploadSamples = async (files: File[]) => {
    if (!editing || files.length === 0) return;
    setIsUploadingSamples(true);
    try {
      const fd = new FormData();
      for (const f of files.slice(0, 6)) fd.append("images", f);
      const res = await apiFetch(`${baseUrl}/api/designer-personas/${editing.id}/reference-images`, {
        method: "POST",
        body: fd,
      });
      if (isForbidden(res)) {
        toast({ variant: "destructive", title: PERMISSION_DENIED_MESSAGE });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Upload failed");
      }
      const updated = await res.json();
      setForm((f) => ({ ...f, referenceImages: updated.referenceImages || f.referenceImages }));
      toast({ title: "Work samples added" });
      reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Upload failed", description: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setIsUploadingSamples(false);
      if (sampleInputRef.current) sampleInputRef.current.value = "";
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setAiUrl("");
    setAiFiles([]);
    setEditorOpen(true);
  };

  const openEdit = (p: DesignerPersona) => {
    setEditing(p);
    setForm({
      name: p.name,
      description: p.description || "",
      typography: p.typography || "",
      composition: p.composition || "",
      colorPhilosophy: p.colorPhilosophy || "",
      textureAndEffects: p.textureAndEffects || "",
      mood: p.mood || "",
      sourceType: p.sourceType || "manual",
      sourceUrl: p.sourceUrl,
      referenceImages: p.referenceImages || [],
    });
    setAiUrl(p.sourceUrl || "");
    setAiFiles([]);
    setEditorOpen(true);
  };

  const runAnalyze = async () => {
    if (!aiUrl.trim() && aiFiles.length === 0) {
      toast({ variant: "destructive", title: "Add a portfolio URL or sample images first" });
      return;
    }
    setIsAnalyzing(true);
    try {
      const fd = new FormData();
      if (aiUrl.trim()) fd.append("url", aiUrl.trim());
      for (const f of aiFiles) fd.append("images", f);
      const res = await apiFetch(`${baseUrl}/api/designer-personas/analyze`, { method: "POST", body: fd });
      if (isForbidden(res)) {
        toast({ variant: "destructive", title: PERMISSION_DENIED_MESSAGE });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Analysis failed");
      }
      const { draft } = await res.json();
      setForm((prev) => ({
        ...prev,
        name: prev.name || draft.name || "",
        description: draft.description || prev.description,
        typography: draft.typography || prev.typography,
        composition: draft.composition || prev.composition,
        colorPhilosophy: draft.colorPhilosophy || prev.colorPhilosophy,
        textureAndEffects: draft.textureAndEffects || prev.textureAndEffects,
        mood: draft.mood || prev.mood,
        sourceType: draft.sourceType || prev.sourceType,
        sourceUrl: draft.sourceUrl ?? prev.sourceUrl,
        referenceImages: [...prev.referenceImages, ...(draft.referenceImages || [])].slice(0, 10),
      }));
      toast({ title: "Draft style fingerprint ready", description: "Review and edit the fields below, then save." });
    } catch (e) {
      toast({ variant: "destructive", title: "Analysis failed", description: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast({ variant: "destructive", title: "Name is required" });
      return;
    }
    setIsSaving(true);
    try {
      const payload = { ...form, name: form.name.trim() };
      const res = editing
        ? await apiFetch(`${baseUrl}/api/designer-personas/${editing.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiFetch(`${baseUrl}/api/designer-personas`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (isForbidden(res)) {
        toast({ variant: "destructive", title: PERMISSION_DENIED_MESSAGE });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Save failed");
      }
      toast({ title: editing ? "Designer updated" : "Designer created" });
      setEditorOpen(false);
      reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Save failed", description: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await apiFetch(`${baseUrl}/api/designer-personas/${deleteTarget.id}`, { method: "DELETE" });
      if (isForbidden(res)) {
        toast({ variant: "destructive", title: PERMISSION_DENIED_MESSAGE });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Delete failed");
      }
      toast({ title: "Designer removed" });
      reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Delete failed", description: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Designers</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Reusable "Inspired by..." style inspirations you can apply to any brand's generations.
            These are style fingerprints distilled from a portfolio or sample work — they guide the
            look and feel, they never imply the designer produced or endorsed the output.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> New Designer
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading designers...
        </div>
      ) : error ? (
        <p className="text-sm text-destructive py-4">{error}</p>
      ) : personas.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center space-y-2">
            <Palette className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No designers yet. Create one manually, or let AI build a style fingerprint from a
              portfolio URL or sample images.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {personas.map((p) => (
            <Card key={p.id} className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">Inspired by {p.name}</CardTitle>
                  <Badge variant="secondary" className="shrink-0 capitalize">
                    {p.sourceType === "url" ? "From portfolio" : p.sourceType === "samples" ? "From samples" : "Manual"}
                  </Badge>
                </div>
                {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-3">
                {p.referenceImages?.length > 0 && (
                  <div className="flex gap-2">
                    {p.referenceImages.slice(0, 3).map((img, i) => (
                      <img
                        key={i}
                        src={img.url}
                        alt={img.label || `${p.name} reference`}
                        className="h-16 w-16 rounded-md object-cover border border-border"
                      />
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground flex-1">{fingerprintSummary(p) || "No fingerprint details yet."}</p>
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                    <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleteTarget(p)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit "Inspired by ${editing.name}"` : "New Designer"}</DialogTitle>
            <DialogDescription>
              A style inspiration used to guide generation — framed as "Inspired by...", never as work by the designer.
            </DialogDescription>
          </DialogHeader>

          {!editing && (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-primary" /> Build with AI (optional)
              </div>
              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1"><Link2 className="h-3 w-3" /> Portfolio URL</Label>
                <Input
                  placeholder="https://portfolio.example.com"
                  value={aiUrl}
                  onChange={(e) => setAiUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1"><ImagePlus className="h-3 w-3" /> Or upload sample images (up to 6)</Label>
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  onChange={(e) => setAiFiles(Array.from(e.target.files || []).slice(0, 6))}
                />
                {aiFiles.length > 0 && (
                  <p className="text-xs text-muted-foreground">{aiFiles.length} image(s) selected</p>
                )}
              </div>
              <Button size="sm" variant="secondary" onClick={runAnalyze} disabled={isAnalyzing}>
                {isAnalyzing ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing...</>) : (<><Sparkles className="mr-2 h-4 w-4" /> Analyze into draft</>)}
              </Button>
              <p className="text-xs text-muted-foreground">
                AI distills a style fingerprint from the work. You review and edit everything below before saving.
              </p>
            </div>
          )}

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                placeholder='e.g. "Neo-Brutalist Editorial"'
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                rows={2}
                placeholder="One or two sentences summarizing the style."
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            {FINGERPRINT_FIELDS.map(({ key, label, placeholder }) => (
              <div key={key} className="space-y-2">
                <Label>{label}</Label>
                <Textarea
                  rows={2}
                  placeholder={placeholder}
                  value={form[key] as string}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                />
              </div>
            ))}
            {(form.referenceImages.length > 0 || editing) && (
              <div className="space-y-2">
                <Label>Reference images</Label>
                <div className="flex flex-wrap gap-2">
                  {form.referenceImages.map((img, i) => (
                    <div key={i} className="relative group">
                      <img src={img.url} alt={img.label || "reference"} className="h-20 w-20 rounded-md object-cover border border-border" />
                      <button
                        type="button"
                        className="absolute -top-2 -right-2 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs"
                        onClick={() => setForm((f) => ({ ...f, referenceImages: f.referenceImages.filter((_, idx) => idx !== i) }))}
                        aria-label="Remove reference image"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                {editing && form.referenceImages.length < 10 && (
                  <div>
                    <input
                      ref={sampleInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      multiple
                      className="hidden"
                      onChange={(e) => void uploadSamples(Array.from(e.target.files || []))}
                      data-testid="designer-sample-upload-input"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isUploadingSamples}
                      onClick={() => sampleInputRef.current?.click()}
                      data-testid="designer-sample-upload-button"
                    >
                      {isUploadingSamples
                        ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading...</>)
                        : "Add work samples"}
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Kept reference images get style-slot priority during generation.</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={isSaving}>
              {isSaving ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</>) : editing ? "Save changes" : "Create designer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "Inspired by {deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the designer style inspiration. Creatives already generated with it keep their images.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={isDeleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
