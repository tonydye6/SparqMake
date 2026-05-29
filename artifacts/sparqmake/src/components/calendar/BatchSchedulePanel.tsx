import { apiFetch } from "@/lib/utils";
import { useState, useEffect, useCallback } from "react";
import { X, CalendarClock, Check, ChevronsRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { batchScheduleCalendarEntries, ApiError } from "@workspace/api-client-react";

export interface BatchSchedulePanelProps {
  open: boolean;
  onClose: () => void;
  onScheduled: () => void;
}

interface Creative {
  id: string;
  name: string;
  brandName: string;
  brandColor: string;
  variantCount: number;
}

export function BatchSchedulePanel({ open, onClose, onScheduled }: BatchSchedulePanelProps) {
  const { toast } = useToast();
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedCreativeIds, setSelectedCreativeIds] = useState<Set<string>>(new Set());
  const [scheduleDates, setScheduleDates] = useState<Record<string, string>>({});
  const [scheduleTimes, setScheduleTimes] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const [sharedDate, setSharedDate] = useState("");
  const [sharedTime, setSharedTime] = useState("09:00");

  const [staggerStartDate, setStaggerStartDate] = useState("");

  const fetchCreatives = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/creatives?status=approved", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch creatives");
      const json = await res.json();
      const data: Creative[] = (json.data || json || []).map((c: any) => ({
        id: c.id,
        name: c.name,
        brandName: c.brandName || c.brand?.name || "Unknown",
        brandColor: c.brandColor || c.brand?.colorPrimary || "#6366f1",
        variantCount: c.variantCount ?? c.variants?.length ?? 0,
      }));
      setCreatives(data);
    } catch {
      toast({ variant: "destructive", title: "Failed to load creatives" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) {
      fetchCreatives();
      setSelectedCreativeIds(new Set());
      setScheduleDates({});
      setScheduleTimes({});
      setSharedDate("");
      setSharedTime("09:00");
      setStaggerStartDate("");
    }
  }, [open, fetchCreatives]);

  const toggleCreative = (id: string) => {
    setSelectedCreativeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedCreativeIds.size === creatives.length) {
      setSelectedCreativeIds(new Set());
    } else {
      setSelectedCreativeIds(new Set(creatives.map((c) => c.id)));
    }
  };

  const applySharedDateTime = () => {
    if (!sharedDate) {
      toast({ variant: "destructive", title: "Please select a date first" });
      return;
    }
    const nextDates: Record<string, string> = { ...scheduleDates };
    const nextTimes: Record<string, string> = { ...scheduleTimes };
    selectedCreativeIds.forEach((id) => {
      nextDates[id] = sharedDate;
      nextTimes[id] = sharedTime || "09:00";
    });
    setScheduleDates(nextDates);
    setScheduleTimes(nextTimes);
    toast({ title: `Applied to ${selectedCreativeIds.size} creatives` });
  };

  const applyStagger = () => {
    if (!staggerStartDate) {
      toast({ variant: "destructive", title: "Please select a start date" });
      return;
    }
    const ids = Array.from(selectedCreativeIds);
    const nextDates: Record<string, string> = { ...scheduleDates };
    const nextTimes: Record<string, string> = { ...scheduleTimes };
    const base = new Date(staggerStartDate + "T00:00:00");
    ids.forEach((id, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      nextDates[id] = d.toISOString().slice(0, 10);
      if (!nextTimes[id]) nextTimes[id] = "09:00";
    });
    setScheduleDates(nextDates);
    setScheduleTimes(nextTimes);
    toast({ title: `Staggered ${ids.length} creatives starting ${staggerStartDate}` });
  };

  const selectedCount = selectedCreativeIds.size;

  const allSelectedHaveDates = selectedCount > 0 && Array.from(selectedCreativeIds).every(
    (id) => scheduleDates[id] && scheduleTimes[id]
  );

  const handleSubmit = async () => {
    if (!allSelectedHaveDates) return;
    setSubmitting(true);
    try {
      const entries = Array.from(selectedCreativeIds).map((creativeId) => {
        const date = scheduleDates[creativeId];
        const time = scheduleTimes[creativeId] || "09:00";
        const scheduledAt = new Date(`${date}T${time}:00`).toISOString();
        return { creativeId, scheduledAt };
      });

      await batchScheduleCalendarEntries({ entries });

      toast({ title: `Scheduled ${entries.length} creative${entries.length > 1 ? "s" : ""}` });
      onScheduled();
      onClose();
    } catch (err) {
      const description = err instanceof ApiError
        ? ((err.data as { error?: string } | null)?.error ?? err.message)
        : err instanceof Error ? err.message : "Something went wrong";
      toast({
        variant: "destructive",
        title: "Scheduling failed",
        description: description || "Something went wrong",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/30 z-40"
          onClick={onClose}
        />
      )}

      <div
        className={`fixed inset-y-0 right-0 w-[400px] max-w-[90vw] bg-card border-l border-border shadow-xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <CalendarClock size={18} className="text-primary" />
            <h2 className="font-semibold text-base">Batch Schedule</h2>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : creatives.length === 0 ? (
            <div className="text-center py-12 px-4 text-muted-foreground text-sm">
              No approved unscheduled creatives found.
            </div>
          ) : (
            <div className="divide-y divide-border">
              <div className="flex items-center gap-3 px-4 py-2 bg-muted/30">
                <Checkbox
                  checked={selectedCreativeIds.size === creatives.length && creatives.length > 0}
                  onCheckedChange={toggleSelectAll}
                />
                <span className="text-xs text-muted-foreground font-medium">
                  {selectedCount > 0
                    ? `${selectedCount} of ${creatives.length} selected`
                    : `Select all (${creatives.length})`}
                </span>
              </div>

              {creatives.map((creative) => {
                const isSelected = selectedCreativeIds.has(creative.id);
                return (
                  <div key={creative.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleCreative(creative.id)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{creative.name}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0"
                            style={{
                              borderColor: creative.brandColor + "60",
                              color: creative.brandColor,
                            }}
                          >
                            {creative.brandName}
                          </Badge>
                          {creative.variantCount > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                              {creative.variantCount} variant{creative.variantCount !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>

                        {isSelected && (
                          <div className="flex items-center gap-2 mt-2">
                            <Input
                              type="date"
                              className="h-7 text-xs flex-1"
                              value={scheduleDates[creative.id] || ""}
                              onChange={(e) =>
                                setScheduleDates((prev) => ({
                                  ...prev,
                                  [creative.id]: e.target.value,
                                }))
                              }
                            />
                            <Input
                              type="time"
                              className="h-7 text-xs w-[100px]"
                              value={scheduleTimes[creative.id] || "09:00"}
                              onChange={(e) =>
                                setScheduleTimes((prev) => ({
                                  ...prev,
                                  [creative.id]: e.target.value,
                                }))
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selectedCount > 0 && (
          <div className="border-t border-border px-4 py-3 space-y-3 shrink-0 bg-muted/20">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Quick Actions
            </p>

            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Same date/time for all</span>
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  className="h-7 text-xs flex-1"
                  value={sharedDate}
                  onChange={(e) => setSharedDate(e.target.value)}
                />
                <Input
                  type="time"
                  className="h-7 text-xs w-[100px]"
                  value={sharedTime}
                  onChange={(e) => setSharedTime(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs px-2"
                  onClick={applySharedDateTime}
                >
                  <Check size={12} className="mr-1" />
                  Apply
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Stagger by 1 day</span>
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  className="h-7 text-xs flex-1"
                  value={staggerStartDate}
                  onChange={(e) => setStaggerStartDate(e.target.value)}
                  placeholder="Start date"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs px-2"
                  onClick={applyStagger}
                >
                  <ChevronsRight size={12} className="mr-1" />
                  Stagger
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-border px-4 py-3 shrink-0">
          <Button
            className="w-full"
            disabled={!allSelectedHaveDates || submitting}
            onClick={handleSubmit}
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="mr-2 animate-spin" />
                Scheduling...
              </>
            ) : (
              <>
                Schedule {selectedCount > 0 ? `${selectedCount} creative${selectedCount > 1 ? "s" : ""}` : "creatives"}
              </>
            )}
          </Button>
        </div>
      </div>
    </>
  );
}
