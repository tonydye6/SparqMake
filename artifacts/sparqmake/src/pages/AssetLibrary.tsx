import { useState, useCallback, useEffect, useRef } from "react";
import { useDropzone } from "react-dropzone";
import { UploadCloud, Search, Filter, FolderPlus, MoreVertical, Image as ImageIcon, Video, FileText, Hash, Check, X, Trash2, Edit2, Plus, CheckSquare, Square, Tag, Archive, Star, Shield, Layers, Eye, EyeOff, Zap, ImagePlus, CheckCircle2, XCircle, Loader2, ImageOff } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  useGetAssets, useUpdateAsset, useDeleteAsset, useCreateAsset,
  useGetBrands, useGetHashtagSets, useCreateHashtagSet, useUpdateHashtagSet, useDeleteHashtagSet,
  type Asset,
  type HashtagSet,
  type CreateAssetInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useForm } from "react-hook-form";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, apiFetch, isForbidden, PERMISSION_DENIED_MESSAGE } from "@/lib/utils";
import { useCanWrite } from "@/hooks/useAuth";
import { Switch } from "@/components/ui/switch";

const API_BASE = import.meta.env.VITE_API_URL || "";

const ASSET_CLASS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  compositing: { label: "Brand Overlay", color: "text-purple-400", bg: "bg-purple-500/20" },
  subject_reference: { label: "Character Reference", color: "text-blue-400", bg: "bg-blue-500/20" },
  style_reference: { label: "Style Inspiration", color: "text-green-400", bg: "bg-green-500/20" },
  context: { label: "Context", color: "text-amber-400", bg: "bg-amber-500/20" },
};

function StarRating({ value, onChange, max = 5, size = 14 }: { value: number; onChange?: (v: number) => void; max?: number; size?: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChange?.(i + 1)}
          disabled={!onChange}
          className={cn(
            "transition-colors",
            onChange ? "cursor-pointer hover:text-yellow-400" : "cursor-default",
            i < value ? "text-yellow-400" : "text-muted-foreground/30"
          )}
        >
          <Star size={size} fill={i < value ? "currentColor" : "none"} />
        </button>
      ))}
    </div>
  );
}

interface CreativeUsage {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export default function AssetLibrary() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canWrite = useCanWrite();

  const [selectedBrand, setSelectedBrand] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  
  const { data: brands } = useGetBrands();

  const { data: visuals, isLoading: visualsLoading } = useGetAssets({ 
    type: "visual", 
    brandId: selectedBrand !== "all" ? selectedBrand : undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    search: searchQuery || undefined,
    limit: 200
  });
  
  const { data: briefs, isLoading: briefsLoading } = useGetAssets({ 
    type: "context",
    brandId: selectedBrand !== "all" ? selectedBrand : undefined,
    limit: 200
  });

  const { data: hashtagSets } = useGetHashtagSets({
    brandId: selectedBrand !== "all" ? selectedBrand : undefined,
  });

  interface UploadItem {
    id: string;
    file: File;
    status: "pending" | "uploading" | "done" | "error";
    error?: string;
  }
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const uploadActiveRef = useRef(false);

  const uploadCompleted = uploadQueue.filter(i => i.status === "done").length;
  const uploadFailed = uploadQueue.filter(i => i.status === "error").length;
  const uploadTotal = uploadQueue.length;
  const isUploading = uploadQueue.some(i => i.status === "uploading" || i.status === "pending");

  const processQueue = useCallback(async () => {
    if (uploadActiveRef.current) return;
    uploadActiveRef.current = true;

    const brandId = selectedBrand !== "all" ? selectedBrand : (brands?.[0]?.id || "");
    const MAX_CONCURRENT = 3;
    let completed = 0;
    let failed = 0;

    const readPending = () =>
      new Promise<UploadItem[]>((resolve) => {
        setUploadQueue((prev) => {
          resolve(prev.filter((p) => p.status === "pending"));
          return prev;
        });
      });

    const uploadOne = async (item: UploadItem) => {
      setUploadQueue(prev => prev.map(p => p.id === item.id ? { ...p, status: "uploading" } : p));
      try {
        const formData = new FormData();
        formData.append("file", item.file);
        const uploadRes = await apiFetch(`${API_BASE}/api/upload`, { method: "POST", body: formData });
        if (!uploadRes.ok) {
          const errData = await uploadRes.json().catch(() => ({ error: "Upload failed" }));
          throw new Error(errData.error || `HTTP ${uploadRes.status}`);
        }
        const { url } = await uploadRes.json();
        const createRes = await apiFetch(`${API_BASE}/api/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brandId,
            type: "visual",
            name: item.file.name,
            status: "uploaded",
            fileUrl: url,
            thumbnailUrl: url,
            mimeType: item.file.type,
            fileSizeBytes: item.file.size,
            tags: [],
          }),
        });
        if (!createRes.ok) throw new Error("Failed to create asset record");
        completed++;
        setUploadQueue(prev => prev.map(p => p.id === item.id ? { ...p, status: "done" } : p));
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : "Unknown error";
        setUploadQueue(prev => prev.map(p => p.id === item.id ? { ...p, status: "error", error: message } : p));
      }
    };

    try {
      let pending = await readPending();
      while (pending.length > 0) {
        for (let i = 0; i < pending.length; i += MAX_CONCURRENT) {
          const batch = pending.slice(i, i + MAX_CONCURRENT);
          await Promise.allSettled(batch.map(uploadOne));
        }
        pending = await readPending();
      }

      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });

      if (failed === 0) {
        toast({ title: `${completed} asset${completed !== 1 ? "s" : ""} uploaded successfully` });
      } else {
        toast({
          variant: "destructive",
          title: `Upload complete: ${completed} succeeded, ${failed} failed`,
        });
      }
    } finally {
      uploadActiveRef.current = false;
    }
  }, [selectedBrand, brands, queryClient, toast]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    const items: UploadItem[] = acceptedFiles.map(file => ({
      id: crypto.randomUUID(),
      file,
      status: "pending" as const,
    }));
    setUploadQueue(prev => [...prev, ...items]);
    void processQueue();
  }, [processQueue]);

  const dismissUploadQueue = useCallback(() => {
    if (!isUploading) setUploadQueue([]);
  }, [isUploading]);

  const { getRootProps, getInputProps, isDragActive, open: openDropzone } = useDropzone({
    onDrop,
    noClick: false,
    multiple: true,
    accept: { "image/*": [], "video/mp4": [".mp4"] },
    maxSize: 50 * 1024 * 1024,
    onDropRejected: (rejections) => {
      toast({
        variant: "destructive",
        title: "Some files were rejected",
        description: rejections.map((r) => r.file.name).join(", "),
      });
    },
  });

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (visuals?.data) {
      setSelectedIds(new Set(visuals.data.map(a => a.id)));
    }
  };

  const clearSelection = () => setSelectedIds(new Set());

  const bulkUpdate = async (updates: { status?: string; tags?: string[] }) => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/assets/bulk-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds), ...updates }),
      });
      if (!res.ok) {
        if (isForbidden(res)) {
          toast({ variant: "destructive", title: PERMISSION_DENIED_MESSAGE });
          return;
        }
        throw new Error("Bulk update failed");
      }
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      clearSelection();
      toast({ title: `${data.updated} asset(s) updated` });
    } catch {
      toast({ variant: "destructive", title: "Bulk update failed" });
    } finally {
      setBulkLoading(false);
    }
  };

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    setBulkLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/assets/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      if (!res.ok) {
        if (isForbidden(res)) {
          setDeleteConfirmOpen(false);
          toast({ variant: "destructive", title: PERMISSION_DENIED_MESSAGE });
          return;
        }
        throw new Error("Bulk delete failed");
      }
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      clearSelection();
      setDeleteConfirmOpen(false);
      toast({ title: `${data.deleted ?? count} asset(s) deleted` });
    } catch {
      toast({ variant: "destructive", title: "Bulk delete failed" });
    } finally {
      setBulkLoading(false);
    }
  };

  const bulkMode = selectedIds.size > 0;

  // Kicks off AI vision analysis for every unanalyzed image asset (optionally
  // scoped to the selected brand). Runs server-side; can take a while.
  const runAnalyzeBackfill = async () => {
    setBackfillLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/assets/analyze-backfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedBrand !== "all" ? { brandId: selectedBrand } : {}),
      });
      if (!res.ok) {
        if (isForbidden(res)) {
          toast({ variant: "destructive", title: PERMISSION_DENIED_MESSAGE });
          return;
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Analysis failed");
      }
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      toast({
        title: "Analysis complete",
        description: `${data.analyzed ?? 0} analyzed, ${data.skipped ?? 0} skipped${data.failed ? `, ${data.failed} failed` : ""}.`,
      });
    } catch (err) {
      toast({ variant: "destructive", title: "Analysis failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setBackfillLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden p-6 max-w-[1600px] mx-auto w-full">
      <div className="flex items-center justify-between mb-8 shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Asset Library</h1>
          <p className="text-muted-foreground mt-1">Manage brand visuals, context briefs, and hashtag sets.</p>
        </div>
      </div>

      <Tabs defaultValue="visuals" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="bg-card border border-border w-fit mb-6">
          <TabsTrigger value="visuals" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary px-6">
            <ImageIcon size={16} className="mr-2" /> Visual Assets
          </TabsTrigger>
          <TabsTrigger value="briefs" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary px-6">
            <FileText size={16} className="mr-2" /> Briefs & Context
          </TabsTrigger>
          <TabsTrigger value="hashtags" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary px-6">
            <Hash size={16} className="mr-2" /> Hashtag Library
          </TabsTrigger>
        </TabsList>

        <div className="flex items-center gap-4 mb-6 shrink-0 flex-wrap">
          <Select value={selectedBrand} onValueChange={setSelectedBrand}>
            <SelectTrigger className="w-[200px] bg-card border-border">
              <SelectValue placeholder="All Brands" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Brands</SelectItem>
              {brands?.map(b => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative flex-1 max-w-md min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
            <Input 
              placeholder="Search assets..." 
              className="pl-10 bg-card border-border" 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px] bg-card border-border">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="uploaded">Uploaded</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>

          {canWrite && (
            <Button
              variant="outline"
              onClick={runAnalyzeBackfill}
              disabled={backfillLoading}
              className="border-border"
              data-testid="analyze-all-assets"
            >
              {backfillLoading ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Zap size={16} className="mr-2" />}
              {backfillLoading ? "Analyzing..." : "Analyze all"}
            </Button>
          )}
        </div>

        <TabsContent value="visuals" className="flex-1 overflow-y-auto mt-0 border-none p-0 outline-none pr-4 pb-10">
          {bulkMode && (
            <div className="mb-4 flex items-center gap-3 bg-primary/10 border border-primary/30 rounded-xl px-4 py-3 sticky top-0 z-10 backdrop-blur-sm">
              <span className="text-sm font-semibold text-primary">{selectedIds.size} selected</span>
              <div className="flex-1" />
              <Button size="sm" variant="outline" onClick={selectAll} className="border-primary/30 text-primary hover:bg-primary/20">
                Select All
              </Button>
              {canWrite && (
                <>
                  <Button size="sm" onClick={() => bulkUpdate({ status: "approved" })} disabled={bulkLoading} className="bg-success hover:bg-success/90 text-white">
                    <Check className="w-3.5 h-3.5 mr-1.5" /> Approve Selected
                  </Button>
                  <Button size="sm" onClick={() => bulkUpdate({ status: "archived" })} disabled={bulkLoading} className="bg-warning hover:bg-warning/90 text-black">
                    <Archive className="w-3.5 h-3.5 mr-1.5" /> Archive Selected
                  </Button>
                  <BulkTagDialog onApply={(tags) => bulkUpdate({ tags })} disabled={bulkLoading} />
                  <Button size="sm" onClick={() => setDeleteConfirmOpen(true)} disabled={bulkLoading} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete Selected
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={clearSelection} className="text-muted-foreground">
                <X className="w-3.5 h-3.5 mr-1" /> Clear
              </Button>
            </div>
          )}

          <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {selectedIds.size} asset(s)?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes the selected asset(s) and cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={bulkLoading}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => { e.preventDefault(); bulkDelete(); }}
                  disabled={bulkLoading}
                  className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                >
                  {bulkLoading ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Trash2 className="w-4 h-4 mr-1.5" />}
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {canWrite && (
          <div 
            {...getRootProps()} 
            className={`mb-8 border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
              isDragActive ? 'border-primary bg-primary/5' : 'border-border bg-card/30 hover:border-primary/50 hover:bg-card/50'
            }`}
          >
            <input {...getInputProps()} />
            <div className="mx-auto w-12 h-12 bg-background rounded-full flex items-center justify-center mb-4 border border-border shadow-sm">
              {isUploading ? <UploadCloud className="text-primary animate-bounce" size={24} /> : <UploadCloud className="text-primary" size={24} />}
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-1">
              {isUploading ? `Uploading ${uploadCompleted + uploadFailed}/${uploadTotal}...` : "Drag & drop files here"}
            </h3>
            <p className="text-sm text-muted-foreground">
              {isUploading ? "Files are uploading in the background" : "Supports JPG, PNG, MP4 — select or drop multiple files at once"}
            </p>
          </div>
          )}

          {canWrite && uploadQueue.length > 0 && (
            <div className="mb-6 rounded-xl border border-border bg-card/50 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-foreground">
                  {isUploading ? "Upload Progress" : "Upload Complete"}
                </h4>
                {!isUploading && (
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); dismissUploadQueue(); }}>
                    <X size={14} className="mr-1" /> Dismiss
                  </Button>
                )}
              </div>
              <div className="w-full bg-muted rounded-full h-2 mb-3">
                <div
                  className={cn(
                    "h-2 rounded-full transition-all duration-300",
                    uploadFailed > 0 ? "bg-orange-500" : "bg-primary"
                  )}
                  style={{ width: `${uploadTotal > 0 ? ((uploadCompleted + uploadFailed) / uploadTotal) * 100 : 0}%` }}
                />
              </div>
              <div className="flex gap-4 text-xs text-muted-foreground mb-3">
                <span className="flex items-center gap-1">
                  <CheckCircle2 size={12} className="text-green-400" /> {uploadCompleted} done
                </span>
                {uploadFailed > 0 && (
                  <span className="flex items-center gap-1">
                    <XCircle size={12} className="text-red-400" /> {uploadFailed} failed
                  </span>
                )}
                {isUploading && (
                  <span className="flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" /> {uploadTotal - uploadCompleted - uploadFailed} remaining
                  </span>
                )}
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {uploadQueue.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-muted/50">
                    {item.status === "done" && <CheckCircle2 size={12} className="text-green-400 shrink-0" />}
                    {item.status === "error" && <XCircle size={12} className="text-red-400 shrink-0" />}
                    {item.status === "uploading" && <Loader2 size={12} className="animate-spin text-primary shrink-0" />}
                    {item.status === "pending" && <div className="w-3 h-3 rounded-full border border-muted-foreground/30 shrink-0" />}
                    <span className="truncate text-foreground">{item.file.name}</span>
                    <span className="ml-auto text-muted-foreground shrink-0">
                      {(item.file.size / 1024).toFixed(0)} KB
                    </span>
                    {item.error && <span className="text-red-400 truncate max-w-[200px]">{item.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {visualsLoading ? (
              Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="aspect-square bg-card rounded-xl border border-border animate-pulse" />
              ))
            ) : visuals?.data && visuals.data.length > 0 ? (
              visuals.data.map((asset) => (
                <VisualAssetCard
                  key={asset.id}
                  asset={asset}
                  selected={selectedIds.has(asset.id)}
                  onToggleSelect={() => toggleSelection(asset.id)}
                  bulkMode={bulkMode}
                  canWrite={canWrite}
                />
              ))
            ) : (
              <div className="col-span-full">
                <EmptyState
                  icon={ImagePlus}
                  title="No assets yet"
                  description={canWrite ? "Upload brand assets to start building creatives" : "No brand assets have been uploaded yet"}
                  actionLabel={canWrite ? "Upload Assets" : undefined}
                  onAction={canWrite ? openDropzone : undefined}
                />
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="briefs" className="flex-1 overflow-y-auto mt-0 pr-4">
          <BriefsTab briefs={briefs?.data || []} brands={brands || []} isLoading={briefsLoading} canWrite={canWrite} />
        </TabsContent>

        <TabsContent value="hashtags" className="flex-1 overflow-y-auto mt-0 pr-4">
          <HashtagsTab sets={hashtagSets?.data || []} brands={brands || []} canWrite={canWrite} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BulkTagDialog({ onApply, disabled }: { onApply: (tags: string[]) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");

  const handleApply = () => {
    const tags = tagInput.split(",").map(s => s.trim()).filter(Boolean);
    if (tags.length > 0) {
      onApply(tags);
      setTagInput("");
      setOpen(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} className="border-primary/30 text-primary hover:bg-primary/20">
          <Tag className="w-3.5 h-3.5 mr-1.5" /> Tag Selected
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Tag Selected Assets</DialogTitle></DialogHeader>
        <div className="space-y-4 pt-4">
          <Input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            placeholder="Enter tags (comma separated)"
          />
          <DialogFooter>
            <Button onClick={handleApply} disabled={!tagInput.trim()}>Apply Tags</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VisualAssetCard({ asset, selected, onToggleSelect, bulkMode, canWrite }: { asset: Asset; selected: boolean; onToggleSelect: () => void; bulkMode: boolean; canWrite: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMutation = useUpdateAsset();
  const deleteMutation = useDeleteAsset();
  const [editMode, setEditMode] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [formData, setFormData] = useState({ name: asset.name, description: asset.description || "", tags: asset.tags?.join(", ") || "", characterIdentityNote: asset.characterIdentityNote || "" });
  const [usageData, setUsageData] = useState<CreativeUsage[] | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  const [fileBroken, setFileBroken] = useState(false);

  useEffect(() => {
    if (isOpen && usageData === null) {
      setUsageLoading(true);
      apiFetch(`${API_BASE}/api/assets/${asset.id}/usage`)
        .then(res => res.json())
        .then(data => setUsageData(Array.isArray(data) ? data : []))
        .catch(() => setUsageData([]))
        .finally(() => setUsageLoading(false));
    }
  }, [isOpen, asset.id, usageData]);

  const handleUpdate = (updates: Record<string, unknown>) => {
    updateMutation.mutate({ id: asset.id, data: updates }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
        toast({ title: "Asset updated" });
        setEditMode(false);
      },
      onError: (err: unknown) => {
        toast({
          variant: "destructive",
          title: isForbidden(err) ? PERMISSION_DENIED_MESSAGE : "Failed to update asset",
        });
      }
    });
  };

  const handleDelete = () => {
    deleteMutation.mutate({ id: asset.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
        setDeleteConfirmOpen(false);
        setIsOpen(false);
        toast({ title: "Asset deleted" });
      },
      onError: (err: unknown) => {
        toast({
          variant: "destructive",
          title: isForbidden(err) ? PERMISSION_DENIED_MESSAGE : "Failed to delete asset",
        });
      }
    });
  };

  const saveEdits = () => {
    const updates: Record<string, unknown> = {
      name: formData.name,
      description: formData.description,
      tags: formData.tags.split(",").map(s => s.trim()).filter(Boolean),
    };
    if (isSubjectReference) {
      updates.characterIdentityNote = formData.characterIdentityNote;
    }
    handleUpdate(updates);
  };

  const isSubjectReference = asset.assetClass === "subject_reference";
  const isImage = !asset.mimeType?.includes("video");

  const runAnalysis = async () => {
    setAnalyzing(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/assets/${asset.id}/analyze`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Analysis failed (${res.status})`);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      toast({ title: "Asset analyzed", description: "AI metadata has been updated." });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Analysis failed",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleSelect();
  };

  const statusColor = (status: string) => {
    if (status === "draft") return "bg-muted text-muted-foreground";
    if (status === "scheduled") return "bg-blue-500/20 text-blue-400";
    if (status === "published" || status === "approved") return "bg-success/20 text-success";
    if (status === "in_review" || status === "pending_review") return "bg-warning/20 text-warning";
    return "bg-muted text-muted-foreground";
  };

  return (
    <>
      <div 
        className={cn(
          "group relative bg-card border rounded-xl overflow-hidden shadow-md hover:shadow-xl transition-all duration-300 cursor-pointer",
          selected ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-primary/50"
        )}
        onClick={() => setIsOpen(true)}
      >
        <div className="aspect-square bg-muted/30 relative overflow-hidden">
          {(asset.thumbnailUrl || asset.fileUrl) && !thumbBroken ? (
            <img 
              src={asset.thumbnailUrl || asset.fileUrl || ""} 
              alt={asset.name}
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105 opacity-90 group-hover:opacity-100"
              onError={() => setThumbBroken(true)}
            />
          ) : thumbBroken ? (
            <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-muted-foreground" data-testid={`asset-file-missing-${asset.id}`}>
              <ImageOff size={28} />
              <span className="text-[11px] font-medium">File missing</span>
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              <ImageIcon size={32} />
            </div>
          )}
          
          {canWrite && (
            <div
              role="checkbox"
              aria-checked={selected}
              aria-label={`Select ${asset.name}`}
              className={cn(
                "absolute top-2 left-2 z-10 transition-opacity duration-200",
                bulkMode || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              onClick={handleCheckboxClick}
            >
              <div className={cn(
                "w-6 h-6 rounded border-2 flex items-center justify-center transition-colors",
                selected
                  ? "bg-primary border-primary text-white"
                  : "bg-background/80 backdrop-blur border-border hover:border-primary"
              )}>
                {selected && <Check size={14} />}
              </div>
            </div>
          )}

          <div className="absolute top-2 right-2 flex gap-1">
            {asset.assetClass && ASSET_CLASS_CONFIG[asset.assetClass] && (
              <Badge className={cn("border-none shadow-sm text-[10px]", ASSET_CLASS_CONFIG[asset.assetClass].bg, ASSET_CLASS_CONFIG[asset.assetClass].color)}>
                {ASSET_CLASS_CONFIG[asset.assetClass].label}
              </Badge>
            )}
            {asset.status === 'approved' && <Badge className="bg-success text-white border-none shadow-sm text-[10px]">Approved</Badge>}
            {asset.status === 'uploaded' && <Badge className="bg-warning text-black border-none shadow-sm text-[10px]">Pending</Badge>}
            {asset.status === 'archived' && <Badge variant="secondary" className="border-none shadow-sm text-[10px]">Archived</Badge>}
          </div>
          <div className="absolute bottom-2 left-2 bg-background/80 backdrop-blur text-foreground rounded px-1.5 py-0.5 text-[10px] font-mono shadow-sm flex items-center gap-1">
            {asset.mimeType?.includes('video') ? <Video size={10} /> : <ImageIcon size={10} />}
            {asset.mimeType?.split('/')[1]?.toUpperCase() || 'FILE'}
          </div>
        </div>
        <div className="p-3">
          <h4 className="text-sm font-semibold text-foreground truncate" title={asset.name}>{asset.name}</h4>
          <div className="flex justify-between items-center mt-1">
            <span className="text-xs text-muted-foreground">{new Date(asset.createdAt).toLocaleDateString()}</span>
            {(asset.subjectIdentityScore || asset.styleStrengthScore) ? (
              <StarRating
                value={Math.round((asset.subjectIdentityScore || asset.styleStrengthScore || 0) * 5)}
                size={10}
              />
            ) : null}
          </div>
        </div>
      </div>

      <Sheet open={isOpen} onOpenChange={(open) => { setIsOpen(open); if (!open) setUsageData(null); }}>
        <SheetContent className="w-full sm:max-w-md border-l border-border bg-card p-0 flex flex-col">
          <div className="p-6 border-b border-border bg-background">
            <SheetTitle className="text-xl">Asset Details</SheetTitle>
          </div>
          
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="aspect-video bg-muted rounded-lg overflow-hidden flex items-center justify-center border border-border">
              {asset.fileUrl && !fileBroken ? (
                asset.mimeType?.includes('video') ? (
                  <video src={asset.fileUrl} controls className="max-w-full max-h-full" onError={() => setFileBroken(true)} />
                ) : (
                  <img src={asset.fileUrl} alt={asset.name} className="max-w-full max-h-full object-contain" onError={() => setFileBroken(true)} />
                )
              ) : fileBroken ? (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <ImageOff size={40} />
                  <span className="text-sm font-medium">File missing from storage</span>
                </div>
              ) : (
                <ImageIcon size={48} className="text-muted-foreground" />
              )}
            </div>

            {editMode ? (
              <div className="space-y-4">
                <Input value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="Asset Name" />
                <Textarea value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} placeholder="Description" rows={3} />
                {isSubjectReference && (
                  <div>
                    <label className="text-sm font-semibold text-foreground mb-1 block">Character Identity Note</label>
                    <p className="text-xs text-muted-foreground mb-1">Tells the AI who this character is for identity-consistent image generation.</p>
                    <Textarea value={formData.characterIdentityNote} onChange={e => setFormData({...formData, characterIdentityNote: e.target.value})} placeholder='e.g. "Rex — Crown U quarterback, blue jersey #7, scar over left eye"' rows={2} />
                  </div>
                )}
                <Input value={formData.tags} onChange={e => setFormData({...formData, tags: e.target.value})} placeholder="Tags (comma separated)" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveEdits} disabled={updateMutation.isPending}>Save</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditMode(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <h3 className="font-bold text-lg flex items-center justify-between">
                    {asset.name}
                    {canWrite && (
                      <Button variant="ghost" size="icon" aria-label="Edit asset" onClick={() => setEditMode(true)} className="h-8 w-8"><Edit2 size={14} /></Button>
                    )}
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">{asset.description || "No description provided."}</p>
                  {isSubjectReference && asset.characterIdentityNote && (
                    <div className="mt-2 p-2 bg-primary/5 border border-primary/20 rounded-md">
                      <span className="text-xs font-semibold text-primary block mb-0.5">Character Identity Note</span>
                      <p className="text-sm text-foreground">{asset.characterIdentityNote}</p>
                    </div>
                  )}
                </div>
                {asset.tags && asset.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {asset.tags.map(t => <Badge key={t} variant="secondary">{t}</Badge>)}
                  </div>
                )}
                
                <div className="grid grid-cols-2 gap-4 text-sm bg-background p-4 rounded-lg border border-border">
                  <div>
                    <span className="text-muted-foreground block text-xs uppercase mb-1">Status</span>
                    <Badge variant="outline">{asset.status}</Badge>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-xs uppercase mb-1">Uploaded</span>
                    <span>{new Date(asset.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-xs uppercase mb-1">Type</span>
                    <span>{asset.mimeType || 'Unknown'}</span>
                  </div>
                  {asset.assetClass && (
                    <div>
                      <span className="text-muted-foreground block text-xs uppercase mb-1">Role</span>
                      <Badge className={cn("text-[10px]", ASSET_CLASS_CONFIG[asset.assetClass]?.bg, ASSET_CLASS_CONFIG[asset.assetClass]?.color)}>
                        {ASSET_CLASS_CONFIG[asset.assetClass]?.label || asset.assetClass}
                      </Badge>
                    </div>
                  )}
                </div>

                {isImage && (
                  <div className="bg-background p-4 rounded-lg border border-border space-y-3" data-testid={`ai-analysis-${asset.id}`}>
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs uppercase text-muted-foreground font-semibold flex items-center gap-1.5">
                        <Zap size={12} /> AI Analysis
                      </h4>
                      <div className="flex items-center gap-2">
                        {asset.aiAnalyzedAt ? (
                          <Badge variant="secondary" className="text-[10px]">
                            Analyzed {new Date(asset.aiAnalyzedAt).toLocaleDateString()}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">Not analyzed</Badge>
                        )}
                        {canWrite && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={runAnalysis} disabled={analyzing} data-testid={`analyze-asset-${asset.id}`}>
                            {analyzing ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Zap size={12} className="mr-1" />}
                            {asset.aiAnalyzedAt ? "Re-analyze" : "Analyze"}
                          </Button>
                        )}
                      </div>
                    </div>
                    {(asset.depictedEntities?.length || 0) > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground block mb-1">Depicts</span>
                        <div className="flex flex-wrap gap-1">
                          {(asset.depictedEntities || []).map((e: string) => <Badge key={e} variant="secondary" className="text-[10px]">{e}</Badge>)}
                        </div>
                      </div>
                    )}
                    {(asset.colors?.length || 0) > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground block mb-1">Colors</span>
                        <div className="flex flex-wrap gap-1.5">
                          {(asset.colors || []).map((c: string) => (
                            <span key={c} className="inline-flex items-center gap-1 text-xs text-foreground">
                              <span className="w-3 h-3 rounded-full border border-border inline-block" style={{ backgroundColor: c }} />
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {asset.styleNotes && (
                      <div>
                        <span className="text-xs text-muted-foreground block mb-1">Style notes</span>
                        <p className="text-sm text-foreground">{asset.styleNotes}</p>
                      </div>
                    )}
                    {(asset.usageCount || 0) > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Used in generation {asset.usageCount} time{asset.usageCount === 1 ? "" : "s"}
                        {asset.lastUsedAt ? ` · last on ${new Date(asset.lastUsedAt).toLocaleDateString()}` : ""}
                      </p>
                    )}
                    {!asset.aiAnalyzedAt && (
                      <p className="text-xs text-muted-foreground">
                        Analysis extracts a description, subjects, colors, and style notes so this asset can be matched to prompts automatically.
                      </p>
                    )}
                  </div>
                )}

                {canWrite && (
                  <IntelligenceEditor asset={asset} onUpdate={handleUpdate} isPending={updateMutation.isPending} />
                )}

                <div className="bg-background p-4 rounded-lg border border-border">
                  <h4 className="text-xs uppercase text-muted-foreground font-semibold mb-3">Used in Creatives</h4>
                  {usageLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : usageData && usageData.length > 0 ? (
                    <div className="space-y-2">
                      {usageData.map(c => (
                        <div key={c.id} className="flex items-center justify-between p-2.5 rounded-md bg-card border border-border">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-foreground truncate">{c.name}</p>
                            <p className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleDateString()}</p>
                          </div>
                          <Badge className={cn("ml-2 text-[10px] shrink-0", statusColor(c.status))}>
                            {c.status.replace('_', ' ')}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Not used in any creatives yet.</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {canWrite && (
            <div className="p-4 border-t border-border bg-background flex flex-col gap-2">
              <div className="flex gap-2 w-full">
                {asset.status !== 'approved' && (
                  <Button className="flex-1 bg-success hover:bg-success/90 text-white" onClick={() => handleUpdate({ status: 'approved' })} disabled={updateMutation.isPending}>
                    <Check className="w-4 h-4 mr-2" /> Approve
                  </Button>
                )}
                {asset.status !== 'archived' && (
                  <Button className="flex-1 bg-warning hover:bg-warning/90 text-black" onClick={() => handleUpdate({ status: 'archived' })} disabled={updateMutation.isPending}>
                    <X className="w-4 h-4 mr-2" /> Archive
                  </Button>
                )}
              </div>
              <Button variant="outline" className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive border-border" onClick={() => setDeleteConfirmOpen(true)} disabled={deleteMutation.isPending}>
                <Trash2 className="w-4 h-4 mr-2" /> Delete Asset
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this asset?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the asset and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {deleteMutation.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Trash2 className="w-4 h-4 mr-1.5" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BriefsTab({ briefs, brands, isLoading, canWrite }: { briefs: Asset[], brands: any[], isLoading: boolean, canWrite: boolean }) {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const { register, handleSubmit, reset } = useForm();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(briefs.map(b => b.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    setBulkLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/assets/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      if (!res.ok) {
        if (isForbidden(res)) {
          setDeleteConfirmOpen(false);
          toast({ variant: "destructive", title: PERMISSION_DENIED_MESSAGE });
          return;
        }
        throw new Error("Bulk delete failed");
      }
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      clearSelection();
      setDeleteConfirmOpen(false);
      toast({ title: `${data.deleted ?? count} brief(s) deleted` });
    } catch {
      toast({ variant: "destructive", title: "Bulk delete failed" });
    } finally {
      setBulkLoading(false);
    }
  };

  const bulkMode = selectedIds.size > 0;

  const createMutation = useCreateAsset({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
        setIsAddOpen(false);
        reset();
        toast({ title: "Brief created" });
      },
      onError: (err: unknown) => {
        toast({
          variant: "destructive",
          title: isForbidden(err) ? PERMISSION_DENIED_MESSAGE : "Failed to create brief",
        });
      }
    }
  });

  const onSubmit = (data: any) => {
    createMutation.mutate({
      data: {
        brandId: data.brandId,
        type: "context",
        name: data.title,
        content: data.content,
        status: "approved",
        tags: data.tags ? data.tags.split(",").map((s:string) => s.trim()) : [],
      } as unknown as CreateAssetInput
    });
  };

  return (
    <div className="space-y-6">
      {bulkMode && (
        <div className="flex items-center gap-3 bg-primary/10 border border-primary/30 rounded-xl px-4 py-3 sticky top-0 z-10 backdrop-blur-sm">
          <span className="text-sm font-semibold text-primary">{selectedIds.size} selected</span>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={selectAll} className="border-primary/30 text-primary hover:bg-primary/20">
            Select All
          </Button>
          {canWrite && (
            <Button size="sm" onClick={() => setDeleteConfirmOpen(true)} disabled={bulkLoading} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete Selected
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={clearSelection} className="text-muted-foreground">
            <X className="w-3.5 h-3.5 mr-1" /> Clear
          </Button>
        </div>
      )}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} brief(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the selected brief(s) and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); bulkDelete(); }}
              disabled={bulkLoading}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {bulkLoading ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Trash2 className="w-4 h-4 mr-1.5" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canWrite && (
      <div className="flex justify-end">
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2"/> Create Brief</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New Context Brief</DialogTitle></DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Brand</label>
                <select {...register("brandId", { required: true })} className="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                  {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Title</label>
                <Input {...register("title", { required: true })} placeholder="e.g. Q3 Creative Messaging" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Content</label>
                <Textarea {...register("content", { required: true })} rows={6} placeholder="Paste brief content here..." />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Tags</label>
                <Input {...register("tags")} placeholder="comma separated" />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createMutation.isPending}>Save Brief</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      )}

      {isLoading ? (
        <div className="space-y-4">
           <Skeleton className="h-24 w-full bg-card rounded-xl" />
           <Skeleton className="h-24 w-full bg-card rounded-xl" />
        </div>
      ) : briefs.length > 0 ? (
        <div className="grid gap-4">
          {briefs.map(brief => {
            const isSelected = selectedIds.has(brief.id);
            return (
            <div key={brief.id} className={cn(
              "bg-card border rounded-xl p-4 flex flex-col md:flex-row gap-4 transition-colors",
              isSelected ? "border-primary ring-1 ring-primary/50" : "border-border hover:border-primary/50"
            )}>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => toggleSelection(brief.id)}
                  className={cn(
                    "shrink-0 self-start mt-1 transition-colors",
                    isSelected ? "text-primary" : "text-muted-foreground/50 hover:text-primary"
                  )}
                  aria-label={isSelected ? "Deselect brief" : "Select brief"}
                >
                  {isSelected ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                </button>
              )}
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="font-bold text-lg text-foreground">{brief.name}</h4>
                  <Badge variant="outline" className="text-[10px]">{brands.find(b => b.id === brief.brandId)?.name || 'Unknown Brand'}</Badge>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2 bg-background p-3 rounded border border-border font-mono">
                  {brief.content}
                </p>
                {brief.tags && brief.tags.length > 0 && (
                  <div className="flex gap-1 mt-3">
                    {brief.tags.map(t => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}
                  </div>
                )}
              </div>
              {canWrite && (
                <div className="flex items-center md:items-start gap-2 shrink-0 md:pl-4 md:border-l border-border">
                  <Button variant="ghost" size="sm"><Edit2 className="w-4 h-4 mr-2" /> Edit</Button>
                </div>
              )}
            </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-64 text-center border border-border border-dashed rounded-xl bg-card/30">
          <FileText size={48} className="text-muted-foreground/50 mb-4" />
          <h3 className="text-xl font-bold text-foreground mb-2">No briefs yet</h3>
          <p className="text-muted-foreground mb-4">Create context documents to guide AI generation.</p>
        </div>
      )}
    </div>
  );
}

function IntelligenceEditor({ asset, onUpdate, isPending }: { asset: Asset; onUpdate: (updates: any) => void; isPending: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [assetClass, setAssetClass] = useState(asset.assetClass || "");
  const [generationRole, setGenerationRole] = useState(asset.generationRole || "");
  const [brandLayer, setBrandLayer] = useState(asset.brandLayer || "");
  const [franchise, setFranchise] = useState(asset.franchise || "");
  const [subjectScore, setSubjectScore] = useState(Math.round((asset.subjectIdentityScore || 0) * 5));
  const [styleScore, setStyleScore] = useState(Math.round((asset.styleStrengthScore || 0) * 5));
  const [freshnessScoreVal, setFreshnessScoreVal] = useState(Math.round((asset.freshnessScore || 0) * 5));
  const [compositingOnly, setCompositingOnly] = useState(asset.compositingOnly || false);
  const [generationAllowed, setGenerationAllowed] = useState(asset.generationAllowed !== false);
  const [conflictTagsStr, setConflictTagsStr] = useState((asset.conflictTags || []).join(", "));
  const [approvedChannelsStr, setApprovedChannelsStr] = useState((asset.approvedChannels || []).join(", "));
  const [approvedTemplatesStr, setApprovedTemplatesStr] = useState((asset.approvedTemplates || []).join(", "));

  const handleSave = () => {
    onUpdate({
      assetClass: assetClass || null,
      generationRole: generationRole || null,
      brandLayer: brandLayer || null,
      franchise: franchise || null,
      subjectIdentityScore: subjectScore / 5,
      styleStrengthScore: styleScore / 5,
      freshnessScore: freshnessScoreVal / 5,
      compositingOnly,
      generationAllowed,
      conflictTags: conflictTagsStr.split(",").map(s => s.trim()).filter(Boolean),
      approvedChannels: approvedChannelsStr.split(",").map(s => s.trim()).filter(Boolean),
      approvedTemplates: approvedTemplatesStr.split(",").map(s => s.trim()).filter(Boolean),
    });
  };

  return (
    <div className="bg-background rounded-lg border border-border overflow-hidden">
      <button
        className="w-full p-4 flex items-center justify-between text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-primary" />
          <span className="text-xs uppercase font-semibold text-muted-foreground">Asset Intelligence</span>
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? "Collapse" : "Expand"}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] uppercase text-muted-foreground font-semibold">Asset Role</label>
              <Select value={assetClass} onValueChange={setAssetClass}>
                <SelectTrigger className="h-8 text-xs bg-card border-border">
                  <SelectValue placeholder="Select class" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compositing">Brand Overlay</SelectItem>
                  <SelectItem value="subject_reference">Character Reference</SelectItem>
                  <SelectItem value="style_reference">Style Inspiration</SelectItem>
                  <SelectItem value="context">Context</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase text-muted-foreground font-semibold">Generation Role</label>
              <Select value={generationRole} onValueChange={setGenerationRole}>
                <SelectTrigger className="h-8 text-xs bg-card border-border">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="primary_subject">Primary Subject</SelectItem>
                  <SelectItem value="supporting">Supporting</SelectItem>
                  <SelectItem value="background">Background</SelectItem>
                  <SelectItem value="overlay">Overlay</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] uppercase text-muted-foreground font-semibold">Brand Layer</label>
              <Select value={brandLayer} onValueChange={setBrandLayer}>
                <SelectTrigger className="h-8 text-xs bg-card border-border">
                  <SelectValue placeholder="Select layer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="primary_logo">Primary Logo</SelectItem>
                  <SelectItem value="secondary_mark">Secondary Mark</SelectItem>
                  <SelectItem value="watermark">Watermark</SelectItem>
                  <SelectItem value="partner">Partner</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase text-muted-foreground font-semibold">Franchise</label>
              <Select value={franchise || "_none"} onValueChange={v => setFranchise(v === "_none" ? "" : v)}>
                <SelectTrigger className="h-8 text-xs bg-card border-border">
                  <SelectValue placeholder="Select Franchise" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">None</SelectItem>
                  <SelectItem value="Sparq">Sparq</SelectItem>
                  <SelectItem value="Crown U">Crown U</SelectItem>
                  <SelectItem value="Mascot Mayhem">Mascot Mayhem</SelectItem>
                  <SelectItem value="Rumble U">Rumble U</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase text-muted-foreground font-semibold">Subject Identity Score</label>
              <StarRating value={subjectScore} onChange={setSubjectScore} size={12} />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase text-muted-foreground font-semibold">Style Strength Score</label>
              <StarRating value={styleScore} onChange={setStyleScore} size={12} />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase text-muted-foreground font-semibold">Freshness Score</label>
              <StarRating value={freshnessScoreVal} onChange={setFreshnessScoreVal} size={12} />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase text-muted-foreground font-semibold">Compositing Only</label>
              <Switch checked={compositingOnly} onCheckedChange={setCompositingOnly} />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase text-muted-foreground font-semibold">Generation Allowed</label>
              <Switch checked={generationAllowed} onCheckedChange={setGenerationAllowed} />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase text-muted-foreground font-semibold">Approved Channels (comma separated)</label>
            <Input value={approvedChannelsStr} onChange={e => setApprovedChannelsStr(e.target.value)} className="h-8 text-xs bg-card border-border" placeholder="twitter, instagram, linkedin" />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase text-muted-foreground font-semibold">Approved Templates (comma separated)</label>
            <Input value={approvedTemplatesStr} onChange={e => setApprovedTemplatesStr(e.target.value)} className="h-8 text-xs bg-card border-border" placeholder="Template IDs" />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase text-muted-foreground font-semibold">Conflict Tags (comma separated)</label>
            <Input value={conflictTagsStr} onChange={e => setConflictTagsStr(e.target.value)} className="h-8 text-xs bg-card border-border" placeholder="e.g. competitor_a, rival_brand" />
          </div>

          <Button size="sm" onClick={handleSave} disabled={isPending} className="w-full">
            {isPending ? "Saving..." : "Save Intelligence Data"}
          </Button>
        </div>
      )}
    </div>
  );
}

function HashtagsTab({ sets, brands, canWrite }: { sets: HashtagSet[], brands: any[], canWrite: boolean }) {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [setToDelete, setSetToDelete] = useState<HashtagSet | null>(null);
  const { register, handleSubmit, reset } = useForm();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createMutation = useCreateHashtagSet({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/hashtag-sets"] });
        setIsAddOpen(false);
        reset();
        toast({ title: "Hashtag set created" });
      },
      onError: (err: unknown) => {
        toast({
          variant: "destructive",
          title: isForbidden(err) ? PERMISSION_DENIED_MESSAGE : "Failed to create hashtag set",
        });
      }
    }
  });

  const deleteMutation = useDeleteHashtagSet({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/hashtag-sets"] });
        toast({ title: "Deleted" });
        setSetToDelete(null);
      },
      onError: (err: unknown) => {
        setSetToDelete(null);
        toast({
          variant: "destructive",
          title: isForbidden(err) ? PERMISSION_DENIED_MESSAGE : "Failed to delete hashtag set",
        });
      }
    }
  });

  const onSubmit = (data: any) => {
    createMutation.mutate({
      data: {
        brandId: data.brandId,
        name: data.name,
        category: data.category,
        hashtags: data.hashtags.split(/[\n,]+/).map((s:string) => s.trim().replace(/^#/, '')).filter(Boolean)
      }
    });
  };

  const categories = ["school_specific", "campaign", "seasonal", "trending", "evergreen"];
  
  const grouped = sets.reduce((acc, set) => {
    if(!acc[set.category]) acc[set.category] = [];
    acc[set.category].push(set);
    return acc;
  }, {} as Record<string, any[]>);

  return (
    <div className="space-y-8">
      {canWrite && (
      <div className="flex justify-end mb-4">
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2"/> Create Hashtag Set</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New Hashtag Set</DialogTitle></DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Brand</label>
                <select {...register("brandId", { required: true })} className="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                  {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <Input {...register("name", { required: true })} placeholder="e.g. Match Day Base" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Category</label>
                  <select {...register("category", { required: true })} className="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                    {categories.map(c => <option key={c} value={c}>{c.replace('_', ' ').toUpperCase()}</option>)}
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Hashtags (comma separated)</label>
                <Textarea {...register("hashtags", { required: true })} rows={4} placeholder="esports, matchday, win" />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createMutation.isPending}>Save Set</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      )}

      {sets.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-center border border-border border-dashed rounded-xl bg-card/30">
          <Hash size={48} className="text-muted-foreground/50 mb-4" />
          <h3 className="text-xl font-bold text-foreground mb-2">Hashtag library empty</h3>
          <p className="text-muted-foreground mb-4">Organize your hashtags by creative and platform.</p>
        </div>
      ) : (
        categories.map(cat => {
          const catSets = grouped[cat];
          if(!catSets || catSets.length === 0) return null;
          
          return (
            <div key={cat} className="space-y-4">
              <h3 className="text-lg font-bold uppercase tracking-wider text-muted-foreground border-b border-border pb-2">
                {cat.replace('_', ' ')}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {catSets.map(set => (
                  <div key={set.id} className="bg-card border border-border rounded-xl p-4 relative group">
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <h4 className="font-bold">{set.name}</h4>
                        <Badge variant="outline" className="text-[10px] mt-1">{brands.find(b => b.id === set.brandId)?.name || 'Unknown'}</Badge>
                      </div>
                      {canWrite && (
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          aria-label={`Delete hashtag set ${set.name}`}
                          className="opacity-0 group-hover:opacity-100 text-destructive hover:bg-destructive/10 hover:text-destructive h-8 w-8"
                          onClick={() => setSetToDelete(set)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {set.hashtags.map((tag:string, i:number) => (
                        <span key={i} className="text-xs text-primary bg-primary/10 px-2 py-1 rounded">#{tag}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}

      <AlertDialog open={!!setToDelete} onOpenChange={(open) => { if(!open) setSetToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this set?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the hashtag set{setToDelete ? ` "${setToDelete.name}"` : ""}. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if(setToDelete) deleteMutation.mutate({ id: setToDelete.id });
              }}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
