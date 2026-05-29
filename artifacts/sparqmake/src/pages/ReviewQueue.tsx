import { apiFetch } from "@/lib/utils";
import { useState, useEffect, useMemo, useCallback } from "react";
import { MoreHorizontal, MessageSquare, Clock, Eye, CheckCircle, Send, X, ChevronRight, ThumbsUp, ThumbsDown, Image as ImageIcon, CalendarIcon, RefreshCw, Check, XCircle, ClipboardCheck, LayoutGrid, Columns } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useGetBrands, useGetCreatives, useUpdateCreative, type Creative } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { PlatformPreviewWrapper } from "@/components/review/PlatformPreviewWrapper";
import { RejectReasonDialog } from "@/components/review/RejectReasonDialog";
import { BulkActionBar } from "@/components/review/BulkActionBar";
import { VariantComparisonView } from "@/components/review/VariantComparisonView";
import { Checkbox } from "@/components/ui/checkbox";
import { ScheduleModal } from "@/components/ScheduleModal";
import { useLocation } from "wouter";
import { formatRejectComment, parseRejectComment, REJECT_CATEGORIES } from "@/lib/reject-reasons";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface Variant {
  id: string;
  creativeId: string;
  platform: string;
  aspectRatio: string;
  rawImageUrl: string | null;
  compositedImageUrl: string | null;
  caption: string;
  headlineText: string | null;
  status: string;
  reviewerComment?: string | null;
}

const COLUMNS = [
  { id: "pending_review", title: "Pending Review", color: "border-t-warning" },
  { id: "in_review", title: "In Review", color: "border-t-primary" },
  { id: "approved", title: "Approved", color: "border-t-success" },
  { id: "scheduled", title: "Scheduled", color: "border-t-muted-foreground" },
];

const PLATFORM_LABELS: Record<string, { name: string; icon: string }> = {
  instagram_feed: { name: "Instagram Feed", icon: "instagram" },
  instagram_story: { name: "Instagram Story", icon: "instagram" },
  twitter: { name: "X (Twitter)", icon: "twitter" },
  linkedin: { name: "LinkedIn", icon: "linkedin" },
  tiktok: { name: "TikTok", icon: "tiktok" },
};

const CATEGORY_COLORS: Record<string, string> = {
  off_brand: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  image_quality: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  caption_issues: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  headline_issues: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  platform_mismatch: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  trademark_violation: "bg-red-500/10 text-red-400 border-red-500/30",
  other: "bg-gray-500/10 text-gray-400 border-gray-500/30",
};

function getCategoryLabel(slug: string): string {
  const cat = REJECT_CATEGORIES.find(c => c.slug === slug);
  return cat ? cat.label : slug;
}

export default function ReviewQueue() {
  const { data: brands } = useGetBrands();
  const { data: creatives, isLoading } = useGetCreatives() as unknown as { data?: { data?: Creative[] }; isLoading: boolean };
  const updateCreative = useUpdateCreative();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [brandFilter, setBrandFilter] = useState("all");
  const [, setLocation] = useLocation();

  const [expandedCreativeId, setExpandedCreativeId] = useState<string | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [loadingVariants, setLoadingVariants] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  // Reject dialog state
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<
    | { type: "single"; variantId: string }
    | { type: "bulk"; variantIds: string[] }
    | null
  >(null);

  const [selectedVariantIds, setSelectedVariantIds] = useState<Set<string>>(new Set());

  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleCreative, setScheduleCreative] = useState<{ id: string; name: string } | null>(null);

  const [viewMode, setViewMode] = useState<"grid" | "compare">(() =>
    (localStorage.getItem("reviewViewMode") as "grid" | "compare") || "grid"
  );

  useEffect(() => {
    localStorage.setItem("reviewViewMode", viewMode);
  }, [viewMode]);

  const filteredCreatives = useMemo(() => {
    if (!creatives?.data) return [];
    return creatives.data.filter(c => {
      if (brandFilter !== "all" && c.brandId !== brandFilter) return false;
      return c.status !== "draft";
    });
  }, [creatives, brandFilter]);

  const columnCreatives = useMemo(() => {
    const map: Record<string, typeof filteredCreatives> = {};
    for (const col of COLUMNS) {
      map[col.id] = filteredCreatives.filter(c => c.status === col.id);
    }
    return map;
  }, [filteredCreatives]);

  const getBrand = (brandId: string) => brands?.find(b => b.id === brandId);

  const expandedCreative = useMemo(() => {
    if (!expandedCreativeId || !creatives?.data) return null;
    return creatives.data.find(c => c.id === expandedCreativeId) || null;
  }, [expandedCreativeId, creatives]);

  const fetchVariants = useCallback(async (creativeId: string) => {
    setLoadingVariants(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/variants`);
      if (resp.ok) {
        const data = await resp.json();
        setVariants(data);
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to load post versions" });
    } finally {
      setLoadingVariants(false);
    }
  }, [toast]);

  useEffect(() => {
    if (expandedCreativeId) {
      fetchVariants(expandedCreativeId);
      setRejectComment("");
      setShowRejectInput(false);
      setSelectedVariantIds(new Set());
      setRejectTarget(null);
      setRejectDialogOpen(false);
    } else {
      setVariants([]);
      setSelectedVariantIds(new Set());
    }
  }, [expandedCreativeId, fetchVariants]);

  const handleStatusChange = (creativeId: string, newStatus: string) => {
    updateCreative.mutate(
      { id: creativeId, data: { status: newStatus } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/creatives"] });
          toast({ title: `Creative moved to ${newStatus.replace(/_/g, " ")}` });
        },
        onError: (err: Error) => {
          toast({ variant: "destructive", title: "Failed to update", description: err.message });
        },
      }
    );
  };

  const handleApprove = () => {
    if (!expandedCreativeId) return;
    updateCreative.mutate(
      { id: expandedCreativeId, data: { status: "approved", reviewedBy: "current_user", reviewComment: "Approved" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/creatives"] });
          toast({ title: "Creative approved!" });
          setExpandedCreativeId(null);
        },
        onError: (err: Error) => {
          toast({ variant: "destructive", title: "Failed to approve creative", description: err.message });
        },
      }
    );
  };

  const handleReject = () => {
    if (!expandedCreativeId || !rejectComment.trim()) {
      toast({ variant: "destructive", title: "Please provide feedback" });
      return;
    }
    updateCreative.mutate(
      { id: expandedCreativeId, data: { status: "draft", reviewedBy: "current_user", reviewComment: rejectComment } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/creatives"] });
          toast({ title: "Creative returned with feedback" });
          setExpandedCreativeId(null);
        },
        onError: (err: Error) => {
          toast({ variant: "destructive", title: "Failed to reject creative", description: err.message });
        },
      }
    );
  };

  const handleVariantApprove = async (variantId: string) => {
    if (!expandedCreativeId) return;
    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${expandedCreativeId}/variants/${variantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status: "approved", reviewerComment: "Approved" }),
      });
      if (resp.ok) {
        setVariants(prev => prev.map(v => v.id === variantId ? { ...v, status: "approved" } : v));
        toast({ title: "Post version approved" });
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to approve post version" });
    }
  };

  // Open reject dialog for a single variant
  const openRejectDialogSingle = (variantId: string) => {
    setRejectTarget({ type: "single", variantId });
    setRejectDialogOpen(true);
  };

  // Open reject dialog for bulk selected variants
  const openRejectDialogBulk = () => {
    if (selectedVariantIds.size === 0) return;
    setRejectTarget({ type: "bulk", variantIds: [...selectedVariantIds] });
    setRejectDialogOpen(true);
  };

  // Handle reject dialog submission
  const handleRejectDialogSubmit = async (category: string, comment: string) => {
    if (!expandedCreativeId || !rejectTarget) return;
    const formattedComment = formatRejectComment(category, comment);

    try {
      if (rejectTarget.type === "single") {
        const resp = await apiFetch(
          `${API_BASE}/api/creatives/${expandedCreativeId}/variants/${rejectTarget.variantId}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ status: "rejected", reviewerComment: formattedComment }),
          }
        );
        if (resp.ok) {
          setVariants(prev =>
            prev.map(v =>
              v.id === rejectTarget.variantId
                ? { ...v, status: "rejected", reviewerComment: formattedComment }
                : v
            )
          );
          toast({ title: "Post version rejected with feedback" });
        } else {
          toast({ variant: "destructive", title: "Failed to reject post version" });
        }
      } else {
        const resp = await apiFetch(
          `${API_BASE}/api/creatives/${expandedCreativeId}/variants/bulk-update`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              variantIds: rejectTarget.variantIds,
              status: "rejected",
              reviewerComment: formattedComment,
            }),
          }
        );
        if (resp.ok) {
          const rejectedSet = new Set(rejectTarget.variantIds);
          setVariants(prev =>
            prev.map(v =>
              rejectedSet.has(v.id)
                ? { ...v, status: "rejected", reviewerComment: formattedComment }
                : v
            )
          );
          toast({ title: `${rejectTarget.variantIds.length} post version(s) rejected with feedback` });
          setSelectedVariantIds(new Set());
        } else {
          toast({ variant: "destructive", title: "Bulk reject failed" });
        }
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to reject post version(s)" });
    }

    setRejectTarget(null);
    setRejectDialogOpen(false);
  };

  const handleScheduleClick = (creative: { id: string; name: string }) => {
    setScheduleCreative(creative);
    setScheduleModalOpen(true);
  };

  const handleRemix = (creative: { id: string }) => {
    const params = new URLSearchParams();
    params.set("remix", creative.id);
    setLocation(`/?${params.toString()}`);
  };

  const toggleVariantSelection = (variantId: string) => {
    setSelectedVariantIds(prev => {
      const next = new Set(prev);
      if (next.has(variantId)) {
        next.delete(variantId);
      } else {
        next.add(variantId);
      }
      return next;
    });
  };

  const handleSelectAllVariants = () => {
    setSelectedVariantIds(new Set(variants.map(v => v.id)));
  };

  const handleClearVariantSelection = () => {
    setSelectedVariantIds(new Set());
  };

  const handleBulkApprove = async () => {
    if (!expandedCreativeId || selectedVariantIds.size === 0) return;
    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${expandedCreativeId}/variants/bulk-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ variantIds: [...selectedVariantIds], status: "approved" }),
      });
      if (resp.ok) {
        setVariants(prev =>
          prev.map(v => selectedVariantIds.has(v.id) ? { ...v, status: "approved" } : v)
        );
        toast({ title: `${selectedVariantIds.size} post version(s) approved` });
        setSelectedVariantIds(new Set());
      } else {
        toast({ variant: "destructive", title: "Bulk approve failed" });
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to bulk approve post versions" });
    }
  };

  const variantStatusSummary = useMemo(() => {
    if (variants.length === 0) return null;
    const approved = variants.filter(v => v.status === "approved").length;
    const rejected = variants.filter(v => v.status === "rejected").length;
    const pending = variants.length - approved - rejected;
    return { approved, rejected, pending, total: variants.length };
  }, [variants]);

  const rejectDialogVariantCount = rejectTarget
    ? rejectTarget.type === "single"
      ? 1
      : rejectTarget.variantIds.length
    : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden p-3 sm:p-6 w-full">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 sm:mb-6 shrink-0 gap-3">
        <div>
          <h1 className="text-xl sm:text-3xl font-bold text-foreground">Review Queue</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">Approve and provide feedback on generated creatives?.</p>
        </div>
        <Select value={brandFilter} onValueChange={setBrandFilter}>
          <SelectTrigger className="w-full sm:w-[180px] bg-card border-border">
            <SelectValue placeholder="All Brands" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Brands</SelectItem>
            {brands?.map(b => (
              <SelectItem key={b.id} value={b.id}>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: b.colorPrimary }} />
                  {b.name}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!isLoading && filteredCreatives.length === 0 && (
        <EmptyState
          icon={ClipboardCheck}
          title="Nothing to review"
          description="Creatives submitted for review will appear here"
          className="mb-6"
        />
      )}

      <div className="flex-1 flex flex-col md:flex-row gap-4 md:gap-6 overflow-hidden">
        <div className={`flex flex-col md:flex-row gap-4 md:gap-6 overflow-x-auto overflow-y-auto md:overflow-y-hidden pb-4 hide-scrollbar transition-all duration-300 ${expandedCreativeId ? 'md:w-[340px] md:shrink-0 max-h-[40vh] md:max-h-none' : 'flex-1'}`}>
          {COLUMNS.map(col => {
            const items = columnCreatives[col.id] || [];
            return (
              <div key={col.id} className={`${expandedCreativeId ? 'md:w-[300px]' : 'md:w-[320px]'} shrink-0 flex flex-col bg-background rounded-xl border border-border min-w-0`}>
                <div className={`p-3 sm:p-4 border-b ${col.color} border-t-4 rounded-t-xl bg-card/50 flex justify-between items-center`}>
                  <h3 className="font-bold text-foreground uppercase tracking-wide text-xs sm:text-sm">{col.title}</h3>
                  <Badge variant="secondary" className="bg-muted text-muted-foreground">{items.length}</Badge>
                </div>

                <div className="flex-1 p-2 sm:p-3 space-y-2 sm:space-y-3 overflow-y-auto">
                  {isLoading ? (
                    Array.from({ length: 2 }).map((_, i) => (
                      <div key={i} className="bg-card border border-border p-4 rounded-lg animate-pulse h-32" />
                    ))
                  ) : items.length === 0 ? (
                    <div className="text-center text-sm text-muted-foreground py-8">
                      No creatives
                    </div>
                  ) : (
                    items.map(creative => {
                      const brand = getBrand(creative.brandId);
                      const isExpanded = expandedCreativeId === creative.id;
                      return (
                        <div
                          key={creative.id}
                          onClick={() => setExpandedCreativeId(isExpanded ? null : creative.id)}
                          className={`bg-card border p-3 sm:p-4 rounded-lg shadow-sm cursor-pointer transition-all group ${isExpanded ? 'border-primary ring-1 ring-primary/30' : 'border-border hover:border-primary/50'}`}
                        >
                          <div className="flex justify-between items-start mb-2 sm:mb-3">
                            {brand && (
                              <Badge
                                variant="outline"
                                className="text-[10px] bg-background"
                                style={{ borderColor: `${brand.colorPrimary}40`, color: brand.colorPrimary }}
                              >
                                {brand.name}
                              </Badge>
                            )}
                            <ChevronRight size={14} className={`text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                          </div>

                          <h4 className="font-semibold text-sm text-foreground mb-2">{creative.name}</h4>

                          {creative.briefText && (
                            <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{creative.briefText}</p>
                          )}

                          <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 sm:pt-3 border-t border-border/50">
                            <div className="flex items-center gap-1">
                              <Clock size={12} />
                              {new Date(creative.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                            </div>
                            <div className="flex gap-1 flex-wrap">
                              {col.id === "pending_review" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-xs text-primary hover:text-primary"
                                  onClick={(e) => { e.stopPropagation(); handleStatusChange(creative.id, "in_review"); }}
                                >
                                  <Eye size={12} className="mr-1" /> Review
                                </Button>
                              )}
                              {col.id === "in_review" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-xs text-success hover:text-success"
                                  onClick={(e) => { e.stopPropagation(); handleStatusChange(creative.id, "approved"); }}
                                >
                                  <CheckCircle size={12} className="mr-1" /> Approve
                                </Button>
                              )}
                              {col.id === "approved" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-xs text-muted-foreground"
                                  onClick={(e) => { e.stopPropagation(); handleScheduleClick({ id: creative.id, name: creative.name }); }}
                                >
                                  <Send size={12} className="mr-1" /> Schedule
                                </Button>
                              )}
                              {(col.id === "approved" || col.id === "scheduled") && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-xs text-muted-foreground"
                                  onClick={(e) => { e.stopPropagation(); handleRemix(creative); }}
                                >
                                  <RefreshCw size={12} className="mr-1" /> Duplicate & Edit
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {expandedCreativeId && expandedCreative && (
          <div className="flex-1 bg-card border border-border rounded-xl flex flex-col overflow-hidden animate-in slide-in-from-right-5 duration-200 min-h-[50vh] md:min-h-0">
            <div className="p-3 sm:p-4 border-b border-border bg-background/50 flex items-center justify-between shrink-0">
              <div className="min-w-0 flex-1">
                <h2 className="font-bold text-base sm:text-lg text-foreground truncate">{expandedCreative.name}</h2>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {(() => {
                    const brand = getBrand(expandedCreative.brandId);
                    return brand ? (
                      <Badge variant="outline" className="text-[10px]" style={{ borderColor: `${brand.colorPrimary}40`, color: brand.colorPrimary }}>
                        {brand.name}
                      </Badge>
                    ) : null;
                  })()}
                  <span className="text-xs text-muted-foreground">
                    Created {new Date(expandedCreative.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 ${viewMode === "grid" ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
                  onClick={() => setViewMode("grid")}
                  title="Grid view"
                >
                  <LayoutGrid size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 ${viewMode === "compare" ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
                  onClick={() => setViewMode("compare")}
                  title="Comparison view"
                >
                  <Columns size={16} />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setExpandedCreativeId(null)}>
                  <X size={16} />
                </Button>
              </div>
            </div>

            {expandedCreative.briefText && (
              <div className="px-3 sm:px-4 py-3 border-b border-border bg-muted/30">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Brief</span>
                <p className="text-sm text-foreground mt-1">{expandedCreative.briefText}</p>
              </div>
            )}

            {expandedCreative.reviewComment && (
              <div className="px-3 sm:px-4 py-3 border-b border-border bg-amber-500/5">
                <span className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold flex items-center gap-1">
                  <MessageSquare size={10} /> Previous Feedback
                </span>
                <p className="text-sm text-foreground mt-1">{expandedCreative.reviewComment}</p>
              </div>
            )}

            {variantStatusSummary && (
              <div className="px-3 sm:px-4 py-2 border-b border-border bg-background/30 flex items-center gap-3 text-xs shrink-0">
                <span className="text-muted-foreground font-medium">Post Versions:</span>
                {variantStatusSummary.approved > 0 && (
                  <span className="flex items-center gap-1 text-green-400">
                    <Check size={12} /> {variantStatusSummary.approved} approved
                  </span>
                )}
                {variantStatusSummary.rejected > 0 && (
                  <span className="flex items-center gap-1 text-red-400">
                    <XCircle size={12} /> {variantStatusSummary.rejected} rejected
                  </span>
                )}
                {variantStatusSummary.pending > 0 && (
                  <span className="text-muted-foreground">{variantStatusSummary.pending} pending</span>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 sm:p-4">
              {loadingVariants ? (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="bg-background border border-border rounded-lg h-64 animate-pulse" />
                  ))}
                </div>
              ) : variants.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <ImageIcon size={48} className="mb-4 opacity-20" />
                  <p className="text-sm">No post versions generated yet</p>
                </div>
              ) : (
                <>
                {/* Variant approval progress bar */}
                {(expandedCreative as any)?.variants && (expandedCreative as any).variants.length > 0 && (() => {
                  const variantList = (expandedCreative as any).variants;
                  const total = variantList.length;
                  const approved = variantList.filter((v: any) => v.status === "approved").length;
                  const rejected = variantList.filter((v: any) => v.status === "rejected").length;
                  const pct = total > 0 ? (approved / total) * 100 : 0;

                  return (
                    <div className="mb-4">
                      <div className="flex items-center justify-between text-sm mb-1.5">
                        <span className="text-muted-foreground">Post Version Review</span>
                        <span className={
                          rejected > 0 ? "font-medium text-red-400" :
                          approved === total ? "font-medium text-green-400" : "font-medium text-amber-400"
                        }>
                          {approved} of {total} approved
                        </span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            rejected > 0 ? "bg-red-500" :
                            approved === total ? "bg-green-500" : "bg-amber-500"
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })()}
                {viewMode === "compare" ? (
                  <VariantComparisonView
                    variants={variants}
                    selectedIds={selectedVariantIds}
                    onToggleSelect={toggleVariantSelection}
                    onApprove={handleVariantApprove}
                    onReject={openRejectDialogSingle}
                  />
                ) : (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {variants.map(variant => {
                      const label = PLATFORM_LABELS[variant.platform] || { name: variant.platform, icon: "twitter" };
                      const isReviewable = expandedCreative.status === "in_review" || expandedCreative.status === "pending_review";
                      const isSelected = selectedVariantIds.has(variant.id);

                      // Parse reject comment for display
                      const parsedComment = variant.status === "rejected" && variant.reviewerComment
                        ? parseRejectComment(variant.reviewerComment)
                        : null;

                      return (
                        <div key={variant.id} className={`bg-background border rounded-lg overflow-hidden transition-colors ${
                          isSelected ? "border-primary ring-1 ring-primary/30" :
                          variant.status === "approved" ? "border-green-500/40" :
                          variant.status === "rejected" ? "border-red-500/40" :
                          "border-border"
                        }`}>
                          <div className="p-2 sm:p-2.5 border-b border-border flex items-center justify-between bg-card/50">
                            <div className="flex items-center gap-2">
                              {isReviewable && (
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={() => toggleVariantSelection(variant.id)}
                                  className="shrink-0"
                                />
                              )}
                              <PlatformIcon platform={label.icon} />
                              <span className="font-semibold text-xs">{label.name}</span>
                              <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 bg-muted rounded">{variant.aspectRatio}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              {variant.status === "approved" && (
                                <Badge className="bg-green-500/10 text-green-400 border-green-500/30 text-[10px]">
                                  <Check size={10} className="mr-0.5" /> Approved
                                </Badge>
                              )}
                              {variant.status === "rejected" && (
                                <Badge className="bg-red-500/10 text-red-400 border-red-500/30 text-[10px]">
                                  <XCircle size={10} className="mr-0.5" /> Rejected
                                </Badge>
                              )}
                            </div>
                          </div>

                          <div className="flex justify-center">
                            <PlatformPreviewWrapper
                              platform={variant.platform}
                              imageUrl={variant.compositedImageUrl || variant.rawImageUrl}
                              caption={variant.caption}
                              headlineText={variant.headlineText}
                            />
                          </div>

                          <div className="p-2 sm:p-3 space-y-2">
                            {variant.headlineText && (
                              <div className="bg-primary/5 border border-primary/20 rounded px-2 py-1.5">
                                <span className="text-[10px] text-primary uppercase tracking-wider font-semibold">Headline</span>
                                <p className="text-xs font-bold text-foreground mt-0.5">{variant.headlineText}</p>
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground line-clamp-4">{variant.caption}</p>

                            {/* Show parsed reject reason for rejected variants */}
                            {variant.status === "rejected" && parsedComment && (
                              <div className="bg-red-500/5 border border-red-500/20 rounded px-2 py-1.5 space-y-1">
                                {parsedComment.category && (
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] ${CATEGORY_COLORS[parsedComment.category] || CATEGORY_COLORS.other}`}
                                  >
                                    {getCategoryLabel(parsedComment.category)}
                                  </Badge>
                                )}
                                <p className="text-xs text-muted-foreground">{parsedComment.comment}</p>
                              </div>
                            )}

                            {isReviewable && variant.status !== "approved" && variant.status !== "rejected" && (
                              <div className="flex gap-2 pt-2 border-t border-border">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs flex-1 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                                  onClick={() => openRejectDialogSingle(variant.id)}
                                >
                                  <ThumbsDown size={12} className="mr-1" /> Reject
                                </Button>
                                <Button
                                  size="sm"
                                  className="h-7 text-xs flex-1 bg-green-600 hover:bg-green-700 text-white"
                                  onClick={() => handleVariantApprove(variant.id)}
                                >
                                  <ThumbsUp size={12} className="mr-1" /> Approve
                                </Button>
                              </div>
                            )}

                            {(variant.status === "approved" || variant.status === "rejected") && isReviewable && (
                              <div className="pt-2 border-t border-border">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 text-[10px] text-muted-foreground w-full"
                                  onClick={async () => {
                                    try {
                                      const resp = await apiFetch(`${API_BASE}/api/creatives/${expandedCreativeId}/variants/${variant.id}`, {
                                        method: "PUT",
                                        headers: { "Content-Type": "application/json" },
                                        credentials: "include",
                                        body: JSON.stringify({ status: "generated" }),
                                      });
                                      if (resp.ok) {
                                        setVariants(prev => prev.map(v => v.id === variant.id ? { ...v, status: "generated", reviewerComment: null } : v));
                                        toast({ title: "Post version reset to pending" });
                                      }
                                    } catch {
                                      toast({ variant: "destructive", title: "Failed to reset post version" });
                                    }
                                  }}
                                >
                                  Reset to Pending
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {(expandedCreative.status === "in_review" || expandedCreative.status === "pending_review") && (
                  <BulkActionBar
                    selectedCount={selectedVariantIds.size}
                    totalCount={variants.length}
                    onApproveSelected={handleBulkApprove}
                    onRejectSelected={openRejectDialogBulk}
                    onSelectAll={handleSelectAllVariants}
                    onClearSelection={handleClearVariantSelection}
                  />
                )}
                </>
              )}
            </div>

            <div className="p-3 sm:p-4 border-t border-border bg-background shrink-0 space-y-3">
              {showRejectInput && (
                <div className="space-y-2">
                  <Textarea
                    placeholder="Provide feedback for the creator..."
                    value={rejectComment}
                    onChange={e => setRejectComment(e.target.value)}
                    className="bg-card border-border text-sm min-h-[80px]"
                  />
                </div>
              )}

              <div className="flex gap-2 flex-wrap">
                {(expandedCreative.status === "in_review" || expandedCreative.status === "pending_review") && (
                  <>
                    {!showRejectInput ? (
                      <>
                        <Button
                          variant="outline"
                          className="flex-1 min-w-[120px] border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                          onClick={() => setShowRejectInput(true)}
                        >
                          <ThumbsDown size={14} className="mr-2" /> Request Changes
                        </Button>
                        <Button
                          className="flex-1 min-w-[120px] bg-green-600 hover:bg-green-700 text-white"
                          onClick={handleApprove}
                        >
                          <ThumbsUp size={14} className="mr-2" /> Approve All
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          className="border-border"
                          onClick={() => { setShowRejectInput(false); setRejectComment(""); }}
                        >
                          Cancel
                        </Button>
                        <Button
                          className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                          onClick={handleReject}
                          disabled={!rejectComment.trim()}
                        >
                          <ThumbsDown size={14} className="mr-2" /> Return with Feedback
                        </Button>
                      </>
                    )}
                  </>
                )}
                {expandedCreative.status === "approved" && (
                  <Button
                    className="flex-1 min-w-[120px] bg-primary hover:bg-primary/90 text-primary-foreground"
                    onClick={() => handleScheduleClick({ id: expandedCreative.id, name: expandedCreative.name })}
                  >
                    <CalendarIcon size={14} className="mr-2" /> Schedule
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground"
                  onClick={() => handleRemix(expandedCreative)}
                >
                  <RefreshCw size={14} className="mr-2" /> Duplicate & Edit
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Reject Reason Dialog */}
      <RejectReasonDialog
        open={rejectDialogOpen}
        onClose={() => {
          setRejectDialogOpen(false);
          setRejectTarget(null);
        }}
        onSubmit={handleRejectDialogSubmit}
        variantCount={rejectDialogVariantCount}
      />

      {scheduleCreative && (
        <ScheduleModal
          open={scheduleModalOpen}
          onOpenChange={setScheduleModalOpen}
          creativeId={scheduleCreative.id}
          creativeName={scheduleCreative.name}
          onScheduled={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/creatives"] });
            setExpandedCreativeId(null);
          }}
        />
      )}
    </div>
  );
}
