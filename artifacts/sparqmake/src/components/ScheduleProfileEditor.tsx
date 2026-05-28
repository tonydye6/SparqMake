import { Fragment, useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Sparkles, RotateCcw, Clock } from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";

interface SlotData {
  day: number;
  hour: number;
  score: number;
  status: "preferred" | "acceptable" | "blocked";
}

interface ScheduleProfileEditorProps {
  brandId: string;
  timezone: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const PLATFORMS = [
  { id: "twitter", label: "Twitter / X" },
  { id: "instagram_feed", label: "Instagram Feed" },
  { id: "instagram_story", label: "Instagram Story" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "tiktok", label: "TikTok" },
];

function formatHour(h: number): string {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case "preferred": return "bg-green-500";
    case "acceptable": return "bg-yellow-500";
    case "blocked": return "bg-zinc-700";
    default: return "bg-zinc-800";
  }
}

function getStatusOpacity(score: number, status: string): string {
  if (status === "blocked") return "opacity-40";
  if (score >= 0.8) return "opacity-100";
  if (score >= 0.6) return "opacity-80";
  if (score >= 0.4) return "opacity-60";
  return "opacity-50";
}

function cycleStatus(current: string): { status: "preferred" | "acceptable" | "blocked"; score: number } {
  switch (current) {
    case "preferred": return { status: "acceptable", score: 0.5 };
    case "acceptable": return { status: "blocked", score: 0.1 };
    case "blocked": return { status: "preferred", score: 0.9 };
    default: return { status: "preferred", score: 0.9 };
  }
}

export function ScheduleProfileEditor({ brandId, timezone }: ScheduleProfileEditorProps) {
  const { toast } = useToast();
  const apiBase = import.meta.env.VITE_API_URL || "";
  const [activePlatform, setActivePlatform] = useState(PLATFORMS[0].id);
  const [profiles, setProfiles] = useState<Record<string, SlotData[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Map<string, SlotData>>(new Map());

  const loadProfiles = useCallback(async () => {
    try {
      const res = await apiFetch(`${apiBase}/api/brands/${brandId}/schedule-profile`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setProfiles(data.profiles || {});
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to load schedule profile" });
    } finally {
      setIsLoading(false);
    }
  }, [apiBase, brandId, toast]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const handleGenerate = async (platform?: string) => {
    setIsGenerating(true);
    try {
      const res = await apiFetch(`${apiBase}/api/brands/${brandId}/schedule-profile/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ platform }),
      });
      if (res.ok) {
        toast({ title: "Schedule profile generated" });
        setPendingChanges(new Map());
        await loadProfiles();
      } else {
        const err = await res.json();
        toast({ variant: "destructive", title: "Generation failed", description: err.error });
      }
    } catch {
      toast({ variant: "destructive", title: "Generation failed" });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCellClick = (day: number, hour: number) => {
    const currentSlots = profiles[activePlatform] || [];
    const key = `${activePlatform}-${day}-${hour}`;
    const pending = pendingChanges.get(key);
    const existing = currentSlots.find(s => s.day === day && s.hour === hour);
    const current = pending || existing || { day, hour, score: 0.1, status: "blocked" as const };
    const next = cycleStatus(current.status);

    const newChanges = new Map(pendingChanges);
    newChanges.set(key, { day, hour, ...next });
    setPendingChanges(newChanges);

    setProfiles(prev => {
      const platSlots = [...(prev[activePlatform] || [])];
      const idx = platSlots.findIndex(s => s.day === day && s.hour === hour);
      if (idx >= 0) {
        platSlots[idx] = { day, hour, ...next };
      } else {
        platSlots.push({ day, hour, ...next });
      }
      return { ...prev, [activePlatform]: platSlots };
    });
  };

  const handleSave = async () => {
    if (pendingChanges.size === 0) return;
    setIsSaving(true);
    try {
      const slots = Array.from(pendingChanges.entries()).map(([key, slot]) => {
        const lastDash = key.lastIndexOf("-");
        const secondLastDash = key.lastIndexOf("-", lastDash - 1);
        const platform = key.substring(0, secondLastDash);
        return {
          platform,
          day: slot.day,
          hour: slot.hour,
          score: slot.score,
          status: slot.status,
        };
      });

      const res = await apiFetch(`${apiBase}/api/brands/${brandId}/schedule-profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ slots }),
      });

      if (res.ok) {
        toast({ title: "Schedule profile saved" });
        setPendingChanges(new Map());
      } else {
        const err = await res.json();
        toast({ variant: "destructive", title: "Save failed", description: err.error });
      }
    } catch {
      toast({ variant: "destructive", title: "Save failed" });
    } finally {
      setIsSaving(false);
    }
  };

  const getSlot = (day: number, hour: number): SlotData => {
    const key = `${activePlatform}-${day}-${hour}`;
    const pending = pendingChanges.get(key);
    if (pending) return pending;
    const platSlots = profiles[activePlatform] || [];
    return platSlots.find(s => s.day === day && s.hour === hour) || { day, hour, score: 0, status: "blocked" as const };
  };

  const hasProfile = (profiles[activePlatform]?.length || 0) > 0;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full bg-muted" />
        <Skeleton className="h-[300px] w-full bg-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {PLATFORMS.map(p => (
          <Button
            key={p.id}
            variant={activePlatform === p.id ? "default" : "outline"}
            size="sm"
            onClick={() => setActivePlatform(p.id)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock size={12} />
            <span>{timezone}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-sm bg-green-500" />
              <span className="text-[10px] text-muted-foreground">Preferred</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-sm bg-yellow-500" />
              <span className="text-[10px] text-muted-foreground">Acceptable</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-sm bg-zinc-700" />
              <span className="text-[10px] text-muted-foreground">Blocked</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasProfile && (
            <button
              className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              onClick={() => handleGenerate(activePlatform)}
              disabled={isGenerating}
            >
              <RotateCcw size={12} /> Reset to AI Defaults
            </button>
          )}
          <Button
            size="sm"
            onClick={() => handleGenerate(activePlatform)}
            disabled={isGenerating}
            className="bg-primary hover:bg-primary/90"
          >
            <Sparkles className={cn("h-4 w-4 mr-1", isGenerating && "animate-spin")} />
            {isGenerating ? "Generating..." : "Generate AI Profile"}
          </Button>
        </div>
      </div>

      {!hasProfile && pendingChanges.size === 0 ? (
        <div className="flex items-center justify-center border-2 border-dashed border-border rounded-lg py-12">
          <div className="text-center">
            <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <h3 className="text-sm font-semibold mb-1">No Schedule Profile Yet</h3>
            <p className="text-xs text-muted-foreground mb-4">Generate an AI-powered schedule profile to see optimal posting times.</p>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[700px]">
            <div className="grid grid-cols-[50px_repeat(24,1fr)] gap-px">
              <div />
              {HOURS.map(h => (
                <div key={h} className="text-center text-[9px] text-muted-foreground py-1">
                  {formatHour(h)}
                </div>
              ))}
              {DAYS.map((dayLabel, dayIndex) => (
                <Fragment key={dayIndex}>
                  <div className="flex items-center text-xs font-medium text-muted-foreground pr-2 justify-end">
                    {dayLabel}
                  </div>
                  {HOURS.map(hour => {
                    const slot = getSlot(dayIndex, hour);
                    return (
                      <button
                        key={`${dayIndex}-${hour}`}
                        className={cn(
                          "aspect-[2/1] min-h-[18px] rounded-sm transition-all hover:ring-1 hover:ring-white/30",
                          getStatusColor(slot.status),
                          getStatusOpacity(slot.score, slot.status),
                        )}
                        onClick={() => handleCellClick(dayIndex, hour)}
                        title={`${dayLabel} ${formatHour(hour)} — ${slot.status} (${(slot.score * 100).toFixed(0)}%)`}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingChanges.size > 0 && (
        <div className="flex items-center justify-between bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2">
          <span className="text-sm text-amber-400">
            {pendingChanges.size} slot{pendingChanges.size !== 1 ? "s" : ""} modified
          </span>
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      )}
    </div>
  );
}
