import { apiFetch } from "@/lib/utils";
import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Sparkles, Clock, AlertTriangle, CheckCircle2, Loader2, X, Calendar,
  ChevronDown, ChevronRight, Edit3, CalendarDays,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { PlatformIcon } from "@/components/ui/platform-icon";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface VariantProposal {
  variantId: string;
  platform: string;
  proposedAt: string;
  rationale: string;
  slotScore: number;
  extended: boolean;
  conflictNote?: string;
}

interface CreativeProposal {
  creativeId: string;
  creativeName: string;
  variants: VariantProposal[];
}

interface SmartScheduleModalProps {
  open: boolean;
  onClose: () => void;
  creativeIds: string[];
  onScheduled?: () => void;
}

interface SocialAccountHealth {
  id: string;
  platform: string;
  accountName: string;
  status: string;
  displayStatus?: string;
}

const UNHEALTHY_STATUSES = new Set(["expired", "needs_reconnect", "revoked"]);

// Variant platforms (instagram_feed, instagram_story...) map to connected-account platforms.
const ACCOUNT_PLATFORM_MAP: Record<string, string> = {
  instagram_feed: "instagram",
  instagram_story: "instagram",
  twitter: "twitter",
  linkedin: "linkedin",
  tiktok: "tiktok",
  youtube: "youtube",
};

const PLATFORM_MAP: Record<string, { label: string; icon: string; color: string }> = {
  instagram_feed: { label: "Instagram Feed", icon: "instagram", color: "#E1306C" },
  instagram_story: { label: "Instagram Story", icon: "instagram", color: "#C13584" },
  twitter: { label: "X/Twitter", icon: "twitter", color: "#1DA1F2" },
  linkedin: { label: "LinkedIn", icon: "linkedin", color: "#0A66C2" },
  tiktok: { label: "TikTok", icon: "tiktok", color: "#ff0050" },
  youtube: { label: "YouTube", icon: "youtube", color: "#FF0000" },
};

function ScoreBar({ score }: { score: number }) {
  const percentage = Math.round(score * 100);
  const color = percentage >= 80 ? "bg-green-500" : percentage >= 60 ? "bg-amber-500" : "bg-red-500";

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${percentage}%` }} />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-8 text-right">{percentage}%</span>
    </div>
  );
}

function MiniTimeline({ proposals }: { proposals: Record<string, CreativeProposal> }) {
  const days = useMemo(() => {
    const dayMap = new Map<string, { label: string; items: Array<{ platform: string; hour: number }> }>();

    for (const cp of Object.values(proposals)) {
      for (const v of cp.variants) {
        if (!v.proposedAt) continue;
        const time = new Date(v.proposedAt);
        const dayKey = time.toISOString().split("T")[0];
        const dayLabel = time.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

        if (!dayMap.has(dayKey)) {
          dayMap.set(dayKey, { label: dayLabel, items: [] });
        }
        dayMap.get(dayKey)!.items.push({ platform: v.platform, hour: time.getHours() });
      }
    }

    return Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value);
  }, [proposals]);

  if (days.length === 0) return null;

  return (
    <div className="bg-background/50 rounded-lg border border-border p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <CalendarDays size={12} className="text-muted-foreground" />
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Schedule Timeline</span>
      </div>
      <div className="flex gap-1">
        {days.map((day, i) => (
          <div key={i} className="flex-1 min-w-0">
            <div className="text-[9px] text-muted-foreground text-center mb-1 truncate">{day.label}</div>
            <div className="space-y-0.5">
              {day.items.map((item, j) => {
                const config = PLATFORM_MAP[item.platform];
                return (
                  <div
                    key={j}
                    className="h-3 rounded-sm flex items-center justify-center"
                    style={{ backgroundColor: `${config?.color || "#888"}20`, borderLeft: `2px solid ${config?.color || "#888"}` }}
                    title={`${config?.label || item.platform} at ${item.hour > 12 ? item.hour - 12 : item.hour}${item.hour >= 12 ? "PM" : "AM"}`}
                  >
                    <span className="text-[7px] font-mono text-muted-foreground">
                      {item.hour > 12 ? item.hour - 12 : item.hour}{item.hour >= 12 ? "p" : "a"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SmartScheduleModal({ open, onClose, creativeIds, onScheduled }: SmartScheduleModalProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [proposals, setProposals] = useState<Record<string, CreativeProposal> | null>(null);
  const [editingSlot, setEditingSlot] = useState<{ creativeId: string; variantId: string } | null>(null);
  const [editDateTime, setEditDateTime] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [expandedCreatives, setExpandedCreatives] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [socialAccounts, setSocialAccounts] = useState<SocialAccountHealth[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiFetch(`${API_BASE}/api/social-accounts`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: SocialAccountHealth[]) => {
        if (!cancelled) setSocialAccounts(Array.isArray(data) ? data : []);
      })
      .catch(() => { /* health warnings are best-effort */ });
    return () => { cancelled = true; };
  }, [open]);

  const fetchProposals = useCallback(async () => {
    setLoading(true);
    setError(null);
    setProposals(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/smart-schedule/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ creativeIds }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to generate proposals" }));
        setError(err.error || "Failed to generate schedule proposals");
        return;
      }

      const data = await res.json();
      setProposals(data.proposals);
      setExpandedCreatives(new Set(Object.keys(data.proposals)));
    } catch {
      setError("Network error — could not reach the scheduling service");
    } finally {
      setLoading(false);
    }
  }, [creativeIds]);

  useEffect(() => {
    if (open && creativeIds.length > 0 && !proposals && !loading) {
      fetchProposals();
    }
  }, [open, creativeIds.length, proposals, loading, fetchProposals]);

  const toggleCreativeExpand = (id: string) => {
    setExpandedCreatives((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleEditTime = (creativeId: string, variantId: string, currentTime: string) => {
    setEditingSlot({ creativeId, variantId });
    if (currentTime) {
      const dt = new Date(currentTime);
      setEditDateTime(dt.toISOString().slice(0, 16));
    } else {
      setEditDateTime("");
    }
  };

  const saveEditedTime = () => {
    if (!editingSlot || !editDateTime || !proposals) return;

    const { creativeId, variantId } = editingSlot;
    const newDate = new Date(editDateTime);

    setProposals((prev) => {
      if (!prev) return prev;
      const creative = prev[creativeId];
      if (!creative) return prev;

      return {
        ...prev,
        [creativeId]: {
          ...creative,
          variants: creative.variants.map((v) =>
            v.variantId === variantId
              ? {
                  ...v,
                  proposedAt: newDate.toISOString(),
                  rationale: `${v.rationale} (manually adjusted)`,
                }
              : v,
          ),
        },
      };
    });

    setEditingSlot(null);
  };

  const handleConfirm = async () => {
    if (!proposals) return;
    setConfirming(true);

    try {
      const allProposals = Object.values(proposals).flatMap((cp) =>
        cp.variants
          .filter((v) => v.proposedAt)
          .map((v) => ({
            creativeId: cp.creativeId,
            variantId: v.variantId,
            platform: v.platform,
            scheduledAt: v.proposedAt,
            rationale: v.rationale,
            slotScore: v.slotScore,
          })),
      );

      if (allProposals.length === 0) {
        toast({ variant: "destructive", title: "No valid proposals to schedule" });
        setConfirming(false);
        return;
      }

      const res = await apiFetch(`${API_BASE}/api/smart-schedule/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ proposals: allProposals }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Scheduling failed" }));
        toast({ variant: "destructive", title: "Failed to confirm schedule", description: err.error });
        return;
      }

      const data = await res.json();
      toast({
        title: "Smart Schedule confirmed",
        description: `${data.created.length} entries scheduled across ${data.creativesScheduled.length} creative(s)`,
      });
      onScheduled?.();
      onClose();
      setProposals(null);
    } catch {
      toast({ variant: "destructive", title: "Scheduling failed" });
    } finally {
      setConfirming(false);
    }
  };

  const handleClose = () => {
    setProposals(null);
    setError(null);
    onClose();
  };

  const totalVariants = proposals
    ? Object.values(proposals).reduce((sum, cp) => sum + cp.variants.filter((v) => v.proposedAt).length, 0)
    : 0;

  const hasExtended = proposals
    ? Object.values(proposals).some((cp) => cp.variants.some((v) => v.extended))
    : false;

  const hasConflicts = proposals
    ? Object.values(proposals).some((cp) => cp.variants.some((v) => v.conflictNote))
    : false;

  const unhealthyPlatformLabels = useMemo(() => {
    if (!proposals) return [];
    const targetPlatforms = new Set<string>();
    for (const cp of Object.values(proposals)) {
      for (const v of cp.variants) {
        if (!v.proposedAt) continue;
        targetPlatforms.add(ACCOUNT_PLATFORM_MAP[v.platform] || v.platform);
      }
    }
    const labels: string[] = [];
    for (const platform of targetPlatforms) {
      const platformAccounts = socialAccounts.filter((a) => a.platform === platform);
      if (platformAccounts.length === 0) continue;
      const allUnhealthy = platformAccounts.every((a) =>
        UNHEALTHY_STATUSES.has(a.displayStatus || a.status),
      );
      if (allUnhealthy) {
        const key = Object.keys(ACCOUNT_PLATFORM_MAP).find((k) => ACCOUNT_PLATFORM_MAP[k] === platform);
        labels.push(PLATFORM_MAP[key || platform]?.label.replace(/ (Feed|Story)$/, "") || platform);
      }
    }
    return Array.from(new Set(labels));
  }, [proposals, socialAccounts]);

  const getScoreColor = (score: number) => {
    if (score >= 0.7) return "text-emerald-400";
    if (score >= 0.5) return "text-amber-400";
    if (score >= 0.3) return "text-orange-400";
    return "text-red-400";
  };

  const getScoreBg = (score: number) => {
    if (score >= 0.7) return "bg-emerald-500/10 border-emerald-500/20";
    if (score >= 0.5) return "bg-amber-500/10 border-amber-500/20";
    if (score >= 0.3) return "bg-orange-500/10 border-orange-500/20";
    return "bg-red-500/10 border-red-500/20";
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-400" />
            Smart Schedule
            {creativeIds.length > 0 && (
              <Badge variant="outline" className="ml-2 text-xs">
                {creativeIds.length} creative{creativeIds.length > 1 ? "s" : ""}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-amber-400" />
              <p className="text-sm text-muted-foreground">
                Analyzing schedule profiles and finding optimal slots...
              </p>
              <p className="text-xs text-muted-foreground">Checking calendar conflicts and platform peak hours</p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-400">Schedule generation failed</p>
                <p className="text-xs text-muted-foreground mt-1">{error}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={fetchProposals}>
                  Try Again
                </Button>
              </div>
            </div>
          )}

          {hasExtended && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300">
                Some slots were scheduled beyond the 7-day window due to conflicts.
                The scheduling window was extended to 14 days.
              </p>
            </div>
          )}

          {unhealthyPlatformLabels.length > 0 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20" data-testid="warning-unhealthy-connections">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">
                {unhealthyPlatformLabels.join(", ")} connection{unhealthyPlatformLabels.length > 1 ? "s need" : " needs"} reconnecting —
                posts scheduled to {unhealthyPlatformLabels.length > 1 ? "these platforms" : "this platform"} will fail to auto-publish.
                Reconnect in Settings → Connected Accounts before the scheduled time.
              </p>
            </div>
          )}

          {hasConflicts && !hasExtended && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <Clock className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <p className="text-xs text-blue-300">
                Some ideal slots were adjusted to avoid same-platform conflicts
                (minimum 2-hour gap between posts on the same platform).
              </p>
            </div>
          )}

          {proposals &&
            Object.values(proposals).map((cp) => {
              const isExpanded = expandedCreatives.has(cp.creativeId);
              const validVariants = cp.variants.filter((v) => v.proposedAt);
              const avgScore =
                validVariants.length > 0
                  ? validVariants.reduce((s, v) => s + v.slotScore, 0) / validVariants.length
                  : 0;

              return (
                <div
                  key={cp.creativeId}
                  className="border border-border rounded-lg overflow-hidden"
                >
                  <button
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
                    onClick={() => toggleCreativeExpand(cp.creativeId)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{cp.creativeName}</p>
                      <p className="text-xs text-muted-foreground">
                        {validVariants.length} variant{validVariants.length !== 1 ? "s" : ""} •{" "}
                        Avg score:{" "}
                        <span className={getScoreColor(avgScore)}>
                          {(avgScore * 100).toFixed(0)}%
                        </span>
                      </p>
                    </div>
                    {validVariants.length > 0 && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    )}
                  </button>

                  {isExpanded && (
                    <div className="border-t border-border divide-y divide-border">
                      {cp.variants.map((v) => {
                        const config = PLATFORM_MAP[v.platform] || { label: v.platform, icon: "twitter", color: "#888" };
                        return (
                          <div key={v.variantId} className="px-4 py-3 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <PlatformIcon platform={config.icon} className="w-4 h-4" />
                                <Badge variant="outline" className="text-[10px] shrink-0">
                                  {config.label}
                                </Badge>
                                {v.proposedAt ? (
                                  <span className="text-sm text-foreground">
                                    {new Date(v.proposedAt).toLocaleDateString("en-US", {
                                      weekday: "short",
                                      month: "short",
                                      day: "numeric",
                                    })}{" "}
                                    at{" "}
                                    {new Date(v.proposedAt).toLocaleTimeString("en-US", {
                                      hour: "numeric",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                ) : (
                                  <span className="text-sm text-red-400">No slot available</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {v.proposedAt && (
                                  <>
                                    <Badge
                                      variant="outline"
                                      className={`text-[10px] ${getScoreBg(v.slotScore)} ${getScoreColor(v.slotScore)}`}
                                    >
                                      {(v.slotScore * 100).toFixed(0)}%
                                    </Badge>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0"
                                      onClick={() => handleEditTime(cp.creativeId, v.variantId, v.proposedAt)}
                                    >
                                      <Edit3 className="w-3.5 h-3.5" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>

                            <ScoreBar score={v.slotScore} />

                            <p className="text-xs text-muted-foreground">{v.rationale}</p>

                            {v.extended && (
                              <div className="flex items-center gap-1.5">
                                <Calendar className="w-3 h-3 text-amber-400" />
                                <span className="text-[10px] text-amber-400">Extended window</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

          {proposals && totalVariants > 0 && (
            <MiniTimeline proposals={proposals} />
          )}
        </div>

        {editingSlot && (
          <div className="border-t border-border pt-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Edit proposed time</p>
            <div className="flex items-center gap-2">
              <Input
                type="datetime-local"
                className="flex-1 h-8 text-xs"
                value={editDateTime}
                onChange={(e) => setEditDateTime(e.target.value)}
              />
              <Button size="sm" className="h-8" onClick={saveEditedTime}>
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => setEditingSlot(null)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={handleClose} className="bg-card border-border">
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!proposals || totalVariants === 0 || confirming}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {confirming ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Confirming...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Confirm Schedule ({totalVariants} variant{totalVariants !== 1 ? "s" : ""})
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
