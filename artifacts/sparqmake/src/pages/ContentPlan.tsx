import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Upload, Plus, Search, Filter, ChevronDown, ChevronUp,
  Trash2, Edit3, Rocket, FileText, X, Check, AlertCircle,
  ArrowUpDown, ArrowUp, ArrowDown, FileSpreadsheet, Sparkles
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { SmartScheduleModal } from "@/components/SmartScheduleModal";
import {
  getContentPlan,
  createPlanItem,
  updatePlanItem,
  deletePlanItem,
  createCreativeFromPlanItem,
  importContentPlan,
  ApiError,
  type PlanItem,
  type UpdatePlanItemInput,
  type ContentPlanImportResponse,
} from "@workspace/api-client-react";

function getApiErrorMessage(err: unknown): string | undefined {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string } | null;
    return data?.error ?? err.message;
  }
  return err instanceof Error ? err.message : undefined;
}

type ImportResult = Pick<ContentPlanImportResponse, "imported" | "rejected" | "rejectedDetails">;

const STATUS_COLORS: Record<string, string> = {
  planned: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  in_progress: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  cancelled: "bg-red-500/20 text-red-400 border-red-500/30",
};

const PLATFORM_OPTIONS = [
  "Instagram", "TikTok", "YouTube", "LinkedIn", "X",
  "Facebook", "Pinterest", "Snapchat", "Threads",
];

const EMPTY_FORM: Omit<PlanItem, "id" | "createdAt" | "updatedAt"> = {
  title: "",
  campaignName: "",
  primaryPlatform: "",
  secondaryPlatforms: [],
  templateName: "",
  pillar: "",
  audience: "",
  brandLayer: "",
  objective: "",
  contentType: "",
  assetPacketType: "",
  coreMessage: "",
  cta: "",
  requiredAssetRoles: [],
  status: "planned",
  plannedWeek: "",
  plannedDate: "",
  notes: "",
  linkedCreativeId: null,
};

type SortField = "title" | "primaryPlatform" | "pillar" | "plannedWeek" | "status";
type SortDir = "asc" | "desc";

export default function ContentPlan() {
  const [items, setItems] = useState<PlanItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filterPillar, setFilterPillar] = useState("all");
  const [filterPlatform, setFilterPlatform] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterWeek, setFilterWeek] = useState("all");
  const [filterBrandLayer, setFilterBrandLayer] = useState("all");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [showImportResult, setShowImportResult] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<PlanItem | null>(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [smartScheduleOpen, setSmartScheduleOpen] = useState(false);

  const fetchItems = useCallback(async () => {
    try {
      const data = await getContentPlan({ limit: 200 });
      setItems(data.items);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const uniquePillars = useMemo(() => [...new Set(items.map(i => i.pillar).filter(Boolean))].sort(), [items]);
  const uniquePlatforms = useMemo(() => [...new Set(items.map(i => i.primaryPlatform).filter(Boolean))].sort(), [items]);
  const uniqueWeeks = useMemo(() => [...new Set(items.map(i => i.plannedWeek).filter(Boolean))].sort(), [items]);
  const uniqueBrandLayers = useMemo(() => [...new Set(items.map(i => i.brandLayer).filter(Boolean))].sort(), [items]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDir === "asc") setSortDir("desc");
      else { setSortField(null); setSortDir("asc"); }
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const filteredItems = useMemo(() => {
    let result = items.filter(item => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesSearch = item.title.toLowerCase().includes(q) ||
          item.campaignName?.toLowerCase().includes(q) ||
          item.coreMessage?.toLowerCase().includes(q) ||
          item.pillar?.toLowerCase().includes(q);
        if (!matchesSearch) return false;
      }
      if (filterPillar !== "all" && item.pillar !== filterPillar) return false;
      if (filterPlatform !== "all" && item.primaryPlatform !== filterPlatform) return false;
      if (filterStatus !== "all" && item.status !== filterStatus) return false;
      if (filterWeek !== "all" && item.plannedWeek !== filterWeek) return false;
      if (filterBrandLayer !== "all" && item.brandLayer !== filterBrandLayer) return false;
      return true;
    });

    if (sortField) {
      result = [...result].sort((a, b) => {
        const aVal = (a[sortField] || "").toLowerCase();
        const bVal = (b[sortField] || "").toLowerCase();
        const cmp = aVal.localeCompare(bVal);
        return sortDir === "asc" ? cmp : -cmp;
      });
    }

    return result;
  }, [items, searchQuery, filterPillar, filterPlatform, filterStatus, filterWeek, filterBrandLayer, sortField, sortDir]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);

    try {
      const data = await importContentPlan({ file });

      setImportResult(data);
      setShowImportResult(true);
      toast({
        title: "Import complete",
        description: `${data.imported} items imported, ${data.rejected} rejected`,
      });
      fetchItems();
    } catch (err) {
      toast({ title: "Import failed", description: getApiErrorMessage(err) ?? "Network error", variant: "destructive" });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePlanItem(id);
      setItems(prev => prev.filter(i => i.id !== id));
      toast({ title: "Plan item deleted" });
      if (expandedId === id) setExpandedId(null);
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  };

  const handleCreateCreative = async (id: string) => {
    try {
      const data = await createCreativeFromPlanItem(id);
      toast({ title: "Creative created", description: `Creative "${data.creative.name}" is ready in Creative Studio` });
      fetchItems();
      const platform = data.planItem?.primaryPlatform ? `&platform=${encodeURIComponent(data.planItem.primaryPlatform)}` : "";
      setLocation(`/?campaign=${data.creative.id}${platform}`);
    } catch (err) {
      if (err instanceof ApiError) {
        const data = err.data as { creativeId?: string; error?: string } | null;
        if (data?.creativeId) {
          toast({ title: "Already linked", description: "This plan item already has a creative" });
          setLocation(`/?campaign=${data.creativeId}`);
          return;
        }
        toast({ title: "Failed to create creative", description: data?.error, variant: "destructive" });
        return;
      }
      toast({ title: "Failed to create creative", variant: "destructive" });
    }
  };

  const openEditModal = (item?: PlanItem) => {
    if (item) {
      setEditingItem(item);
      setFormData({
        title: item.title,
        campaignName: item.campaignName || "",
        primaryPlatform: item.primaryPlatform,
        secondaryPlatforms: item.secondaryPlatforms,
        templateName: item.templateName || "",
        pillar: item.pillar || "",
        audience: item.audience || "",
        brandLayer: item.brandLayer || "",
        objective: item.objective || "",
        contentType: item.contentType || "",
        assetPacketType: item.assetPacketType || "",
        coreMessage: item.coreMessage || "",
        cta: item.cta || "",
        requiredAssetRoles: item.requiredAssetRoles,
        status: item.status,
        plannedWeek: item.plannedWeek || "",
        plannedDate: item.plannedDate || "",
        notes: item.notes || "",
        linkedCreativeId: item.linkedCreativeId,
      });
    } else {
      setEditingItem(null);
      setFormData({ ...EMPTY_FORM });
    }
    setEditModalOpen(true);
  };

  const handleSaveItem = async () => {
    if (!formData.title || !formData.primaryPlatform) {
      toast({ title: "Title and primary platform are required", variant: "destructive" });
      return;
    }

    setCreating(true);
    try {
      const payload = {
        ...formData,
        campaignName: formData.campaignName || null,
        templateName: formData.templateName || null,
        pillar: formData.pillar || null,
        audience: formData.audience || null,
        brandLayer: formData.brandLayer || null,
        objective: formData.objective || null,
        contentType: formData.contentType || null,
        assetPacketType: formData.assetPacketType || null,
        coreMessage: formData.coreMessage || null,
        cta: formData.cta || null,
        plannedWeek: formData.plannedWeek || null,
        plannedDate: formData.plannedDate || null,
        notes: formData.notes || null,
      };

      if (editingItem) {
        await updatePlanItem(editingItem.id, payload as UpdatePlanItemInput);
      } else {
        await createPlanItem(payload);
      }
      toast({ title: editingItem ? "Plan item updated" : "Plan item created" });
      setEditModalOpen(false);
      fetchItems();
    } catch (err) {
      toast({ title: "Save failed", description: getApiErrorMessage(err), variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const clearFilters = () => {
    setSearchQuery("");
    setFilterPillar("all");
    setFilterPlatform("all");
    setFilterStatus("all");
    setFilterWeek("all");
    setFilterBrandLayer("all");
  };

  const hasActiveFilters = filterPillar !== "all" || filterPlatform !== "all" ||
    filterStatus !== "all" || filterWeek !== "all" || filterBrandLayer !== "all" || searchQuery !== "";

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredItems.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredItems.map((i) => i.id)));
    }
  };

  const selectedWithCreatives = useMemo(
    () => filteredItems.filter((i) => selectedIds.has(i.id) && i.linkedCreativeId),
    [filteredItems, selectedIds],
  );

  const batchSmartScheduleReady = selectedWithCreatives.length >= 2;

  return (
    <div className="flex-1 p-6 space-y-6 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Content Plan</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Plan, organize, and convert content items into creatives
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileUpload}
            className="hidden"
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            <Upload className="w-4 h-4 mr-2" />
            {importing ? "Importing..." : "Import CSV"}
          </Button>
          <Button onClick={() => openEditModal()}>
            <Plus className="w-4 h-4 mr-2" />
            New Plan Item
          </Button>
          {selectedIds.size > 0 && (
            <Button
              variant={batchSmartScheduleReady ? "default" : "outline"}
              disabled={!batchSmartScheduleReady}
              onClick={() => setSmartScheduleOpen(true)}
              title={
                batchSmartScheduleReady
                  ? `Smart schedule ${selectedWithCreatives.length} creatives`
                  : "Select 2+ items with linked creatives"
              }
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Batch Smart Schedule
              {selectedWithCreatives.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {selectedWithCreatives.length}
                </Badge>
              )}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search plans..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={filterPillar} onValueChange={setFilterPillar}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Pillar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Pillars</SelectItem>
            {uniquePillars.map(p => (
              <SelectItem key={p} value={p!}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterPlatform} onValueChange={setFilterPlatform}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Platform" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Platforms</SelectItem>
            {uniquePlatforms.map(p => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="planned">Planned</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterWeek} onValueChange={setFilterWeek}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Week" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Weeks</SelectItem>
            {uniqueWeeks.map(w => (
              <SelectItem key={w} value={w!}>{w}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterBrandLayer} onValueChange={setFilterBrandLayer}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Brand Layer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Brand Layers</SelectItem>
            {uniqueBrandLayers.map(b => (
              <SelectItem key={b} value={b!}>{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="w-4 h-4 mr-1" /> Clear
          </Button>
        )}
      </div>

      <div className="text-sm text-muted-foreground">
        {filteredItems.length} of {items.length} plan items
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={FileSpreadsheet}
          title="No content planned"
          description="Import a CSV or create your first content plan item"
          actionLabel="Import CSV"
          onAction={() => fileInputRef.current?.click()}
        />
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="grid grid-cols-[32px_1fr_100px_130px_80px_90px_280px] gap-2 bg-muted/50 border-b border-border px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
              <Checkbox
                checked={filteredItems.length > 0 && selectedIds.size === filteredItems.length}
                onCheckedChange={toggleSelectAll}
              />
            </div>
            <SortHeader field="title" label="Title" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="primaryPlatform" label="Platform" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="pillar" label="Pillar" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="plannedWeek" label="Week" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="status" label="Status" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <div className="text-right">Actions</div>
          </div>

          {filteredItems.map(item => (
            <div key={item.id} className={`border-b border-border last:border-b-0 ${selectedIds.has(item.id) ? "bg-primary/5" : ""}`}>
              <div
                className="grid grid-cols-[32px_1fr_100px_130px_80px_90px_280px] gap-2 px-4 py-3 items-center hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(item.id)}
                    onCheckedChange={() => toggleSelect(item.id)}
                  />
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  {expandedId === item.id ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                    {item.campaignName && (
                      <p className="text-xs text-muted-foreground truncate">{item.campaignName}</p>
                    )}
                  </div>
                </div>
                <div className="text-sm text-foreground">{item.primaryPlatform}</div>
                <div className="text-sm text-foreground truncate">{item.pillar || "—"}</div>
                <div className="text-sm text-foreground">{item.plannedWeek || "—"}</div>
                <div>
                  <Badge variant="outline" className={STATUS_COLORS[item.status] || ""}>
                    {item.status.replace("_", " ")}
                  </Badge>
                </div>
                <div className="flex items-center justify-end gap-2" onClick={e => e.stopPropagation()}>
                  {item.status === "planned" && !item.linkedCreativeId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCreateCreative(item.id)}
                      title="Create Creative"
                      className="text-primary border-primary/40 hover:bg-primary/10 gap-1.5"
                    >
                      <Rocket className="w-3.5 h-3.5" />
                      <span className="text-xs">Create Creative</span>
                    </Button>
                  )}
                  {item.linkedCreativeId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setLocation(`/?campaign=${item.linkedCreativeId}`)}
                      title="Open Creative"
                      className="text-green-400 border-green-400/40 hover:bg-green-400/10 gap-1.5"
                    >
                      <Rocket className="w-3.5 h-3.5" />
                      <span className="text-xs">Open Creative</span>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEditModal(item)}
                    title="Edit"
                  >
                    <Edit3 className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(item.id)}
                    title="Delete"
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {expandedId === item.id && (
                <div className="px-4 pb-4 pt-1 bg-muted/20 border-t border-border">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                    <DetailField label="Creative Name" value={item.campaignName} />
                    <DetailField label="Template" value={item.templateName} />
                    <DetailField label="Audience" value={item.audience} />
                    <DetailField label="Brand Layer" value={item.brandLayer} />
                    <DetailField label="Objective" value={item.objective} />
                    <DetailField label="Content Type" value={item.contentType} />
                    <DetailField label="Asset Packet" value={item.assetPacketType} />
                    <DetailField label="Planned Date" value={item.plannedDate} />
                    <DetailField label="CTA" value={item.cta} />
                    <div className="md:col-span-2 lg:col-span-3">
                      <DetailField label="Core Message" value={item.coreMessage} />
                    </div>
                    {item.secondaryPlatforms.length > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground font-medium">Secondary Platforms</span>
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {item.secondaryPlatforms.map(p => (
                            <Badge key={p} variant="outline" className="text-xs">{p}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {item.requiredAssetRoles.length > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground font-medium">Required Asset Roles</span>
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {item.requiredAssetRoles.map(r => (
                            <Badge key={r} variant="outline" className="text-xs">{r}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {item.notes && (
                      <div className="md:col-span-2 lg:col-span-3">
                        <DetailField label="Notes" value={item.notes} />
                      </div>
                    )}
                    {item.linkedCreativeId && (
                      <div>
                        <span className="text-xs text-muted-foreground font-medium">Linked Creative</span>
                        <p className="text-foreground mt-0.5">
                          <Button
                            variant="link"
                            size="sm"
                            className="p-0 h-auto text-primary"
                            onClick={() => setLocation(`/?campaign=${item.linkedCreativeId}`)}
                          >
                            View in Creative Studio →
                          </Button>
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={showImportResult} onOpenChange={setShowImportResult}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Results</DialogTitle>
          </DialogHeader>
          {importResult && (
            <div className="space-y-4">
              <div className="flex gap-4">
                <div className="flex-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-4 text-center">
                  <div className="text-2xl font-bold text-emerald-400">{importResult.imported}</div>
                  <div className="text-xs text-muted-foreground mt-1">Imported</div>
                </div>
                <div className="flex-1 rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-center">
                  <div className="text-2xl font-bold text-red-400">{importResult.rejected}</div>
                  <div className="text-xs text-muted-foreground mt-1">Rejected</div>
                </div>
              </div>
              {importResult.rejectedDetails.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Rejected Rows:</p>
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {importResult.rejectedDetails.map((r, i) => (
                      <div key={i} className="flex gap-2 text-xs text-muted-foreground bg-muted/50 rounded px-3 py-2">
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                        <span>Row {r.row}: {r.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowImportResult(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SmartScheduleModal
        open={smartScheduleOpen}
        onClose={() => setSmartScheduleOpen(false)}
        creativeIds={selectedWithCreatives.map((i) => i.linkedCreativeId!)}
        onScheduled={() => {
          setSelectedIds(new Set());
          fetchItems();
        }}
      />

      <Dialog open={editModalOpen} onOpenChange={setEditModalOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Plan Item" : "New Plan Item"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label>Title *</Label>
              <Input
                value={formData.title}
                onChange={e => setFormData(f => ({ ...f, title: e.target.value }))}
                placeholder="Post title"
              />
            </div>
            <div>
              <Label>Creative Name</Label>
              <Input
                value={formData.campaignName || ""}
                onChange={e => setFormData(f => ({ ...f, campaignName: e.target.value }))}
                placeholder="Creative name"
              />
            </div>
            <div>
              <Label>Primary Platform *</Label>
              <Select
                value={formData.primaryPlatform}
                onValueChange={v => setFormData(f => ({ ...f, primaryPlatform: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select platform" />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORM_OPTIONS.map(p => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Template Name</Label>
              <Input
                value={formData.templateName || ""}
                onChange={e => setFormData(f => ({ ...f, templateName: e.target.value }))}
                placeholder="Template name"
              />
            </div>
            <div>
              <Label>Pillar</Label>
              <Input
                value={formData.pillar || ""}
                onChange={e => setFormData(f => ({ ...f, pillar: e.target.value }))}
                placeholder="Content pillar"
              />
            </div>
            <div>
              <Label>Audience</Label>
              <Input
                value={formData.audience || ""}
                onChange={e => setFormData(f => ({ ...f, audience: e.target.value }))}
                placeholder="Target audience"
              />
            </div>
            <div>
              <Label>Brand Layer</Label>
              <Input
                value={formData.brandLayer || ""}
                onChange={e => setFormData(f => ({ ...f, brandLayer: e.target.value }))}
                placeholder="Brand layer"
              />
            </div>
            <div>
              <Label>Objective</Label>
              <Input
                value={formData.objective || ""}
                onChange={e => setFormData(f => ({ ...f, objective: e.target.value }))}
                placeholder="Objective"
              />
            </div>
            <div>
              <Label>Content Type</Label>
              <Input
                value={formData.contentType || ""}
                onChange={e => setFormData(f => ({ ...f, contentType: e.target.value }))}
                placeholder="Content type"
              />
            </div>
            <div>
              <Label>Asset Packet Type</Label>
              <Input
                value={formData.assetPacketType || ""}
                onChange={e => setFormData(f => ({ ...f, assetPacketType: e.target.value }))}
                placeholder="Asset packet type"
              />
            </div>
            <div>
              <Label>CTA</Label>
              <Input
                value={formData.cta || ""}
                onChange={e => setFormData(f => ({ ...f, cta: e.target.value }))}
                placeholder="Call to action"
              />
            </div>
            <div className="md:col-span-2">
              <Label>Secondary Platforms</Label>
              <Input
                value={formData.secondaryPlatforms.join(", ")}
                onChange={e => setFormData(f => ({
                  ...f,
                  secondaryPlatforms: e.target.value.split(",").map(s => s.trim()).filter(Boolean)
                }))}
                placeholder="e.g. Instagram, TikTok (comma-separated)"
              />
            </div>
            <div className="md:col-span-2">
              <Label>Required Asset Roles</Label>
              <Input
                value={formData.requiredAssetRoles.join(", ")}
                onChange={e => setFormData(f => ({
                  ...f,
                  requiredAssetRoles: e.target.value.split(",").map(s => s.trim()).filter(Boolean)
                }))}
                placeholder="e.g. style_reference, compositing_logo (comma-separated)"
              />
            </div>
            <div>
              <Label>Planned Week</Label>
              <Input
                value={formData.plannedWeek || ""}
                onChange={e => setFormData(f => ({ ...f, plannedWeek: e.target.value }))}
                placeholder="e.g. Week 1"
              />
            </div>
            <div>
              <Label>Planned Date</Label>
              <Input
                value={formData.plannedDate || ""}
                onChange={e => setFormData(f => ({ ...f, plannedDate: e.target.value }))}
                placeholder="Planned date"
                type="date"
              />
            </div>
            {editingItem && (
              <div>
                <Label>Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={v => setFormData(f => ({ ...f, status: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="planned">Planned</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="md:col-span-2">
              <Label>Core Message</Label>
              <Textarea
                value={formData.coreMessage || ""}
                onChange={e => setFormData(f => ({ ...f, coreMessage: e.target.value }))}
                placeholder="Core message for the content"
                rows={2}
              />
            </div>
            <div className="md:col-span-2">
              <Label>Notes</Label>
              <Textarea
                value={formData.notes || ""}
                onChange={e => setFormData(f => ({ ...f, notes: e.target.value }))}
                placeholder="Additional notes"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveItem} disabled={creating}>
              {creating ? "Saving..." : editingItem ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <span className="text-xs text-muted-foreground font-medium">{label}</span>
      <p className="text-foreground mt-0.5">{value || "—"}</p>
    </div>
  );
}

function SortHeader({ field, label, sortField, sortDir, onSort }: {
  field: SortField;
  label: string;
  sortField: SortField | null;
  sortDir: SortDir;
  onSort: (f: SortField) => void;
}) {
  const active = sortField === field;
  return (
    <button
      className="flex items-center gap-1 hover:text-foreground transition-colors text-left"
      onClick={() => onSort(field)}
    >
      {label}
      {active ? (
        sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-40" />
      )}
    </button>
  );
}
