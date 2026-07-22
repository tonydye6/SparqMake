import { useState, useEffect } from "react";
import { Loader2, Check, Video, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FanOutPlatformCard } from "./types";
import { API_BASE, PLATFORM_LABELS } from "./types";

interface FanOutCardProps {
  platforms: FanOutPlatformCard[];
  onSchedule: (schedules: Array<{ variantId: string; platform: string; scheduledAt: string }>) => void;
  onConvertVideo: (sourceVariantId: string) => void;
  convertedVariants?: Record<string, string>;
}

export function FanOutCard({
  platforms,
  onSchedule,
  onConvertVideo,
  convertedVariants = {},
}: FanOutCardProps) {
  const [convertingIds, setConvertingIds] = useState<Set<string>>(new Set());

  const [approvals, setApprovals] = useState<Record<string, { approved: boolean; scheduledAt: string }>>(() =>
    Object.fromEntries(
      platforms
        .filter(p => !p.requiresVideo)
        .map(p => [p.variantId, { approved: true, scheduledAt: p.suggestedAt }])
    )
  );

  useEffect(() => {
    setApprovals(prev => {
      const next = { ...prev };
      for (const [sourceId, videoId] of Object.entries(convertedVariants)) {
        if (videoId && !next[videoId]) {
          const card = platforms.find(p => p.variantId === sourceId);
          next[videoId] = { approved: true, scheduledAt: card?.suggestedAt ?? new Date().toISOString() };
        }
      }
      return next;
    });
  }, [convertedVariants, platforms]);

  const toggleApprove = (variantId: string) =>
    setApprovals(prev => ({ ...prev, [variantId]: { ...prev[variantId]!, approved: !prev[variantId]?.approved } }));

  const setTime = (variantId: string, val: string) => {
    try {
      setApprovals(prev => ({ ...prev, [variantId]: { ...prev[variantId]!, scheduledAt: new Date(val).toISOString() } }));
    } catch {}
  };

  const handleConvertVideo = (sourceVariantId: string) => {
    setConvertingIds(prev => new Set([...prev, sourceVariantId]));
    onConvertVideo(sourceVariantId);
  };

  const scheduleVariantId = (p: FanOutPlatformCard) =>
    (p.requiresVideo && convertedVariants[p.variantId]) ? convertedVariants[p.variantId] : p.variantId;

  const approvedPlatforms = platforms.filter(p => {
    const vid = scheduleVariantId(p);
    return approvals[vid]?.approved;
  });

  const handleSchedule = () => {
    const schedules = approvedPlatforms.map(p => {
      const vid = scheduleVariantId(p);
      const a = approvals[vid];
      return {
        variantId: vid,
        platform: p.platform,
        scheduledAt: a?.scheduledAt || p.suggestedAt,
      };
    });
    if (schedules.length > 0) onSchedule(schedules);
  };

  return (
    <div className="space-y-2 mt-1">
      <div className="grid grid-cols-2 gap-1.5">
        {platforms.map(p => {
          const videoId = p.requiresVideo ? convertedVariants[p.variantId] : undefined;
          const isConverted = Boolean(videoId);
          const isConverting = convertingIds.has(p.variantId) && !isConverted;
          const vid = scheduleVariantId(p);
          const a = approvals[vid];

          // C1: Build a local datetime string without UTC->local drift.
          const dtLocal = a?.scheduledAt
            ? (() => {
                const d = new Date(a.scheduledAt);
                const pad = (n: number) => String(n).padStart(2, "0");
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
              })()
            : "";

          // YouTube card: three states
          if (p.requiresVideo && !isConverted) {
            return (
              <div
                key={p.variantId}
                className="border border-dashed border-border rounded-lg overflow-hidden opacity-90"
              >
                <div className="relative">
                  <img src={`${API_BASE}${p.imageUrl}`} alt={p.platform} className="w-full aspect-square object-cover" />
                  <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-1.5 p-2">
                    <span className="text-[10px] font-bold bg-black/60 text-white px-1.5 py-0.5 rounded">
                      {PLATFORM_LABELS[p.platform] || p.platform}
                    </span>
                    {isConverting ? (
                      <div className="flex items-center gap-1 text-white/90">
                        <Loader2 size={10} className="animate-spin" />
                        <span className="text-[9px]">Converting...</span>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleConvertVideo(p.variantId)}
                        className="flex items-center gap-1 bg-primary text-primary-foreground rounded px-2 py-0.5 text-[9px] font-semibold hover:bg-primary/90 transition-colors"
                      >
                        <Video size={8} />
                        Convert to video
                      </button>
                    )}
                  </div>
                </div>
                <div className="px-2 pb-2 pt-1">
                  <p className="text-[10px] text-muted-foreground line-clamp-2">{p.caption}</p>
                </div>
              </div>
            );
          }

          return (
            <div
              key={vid}
              className={cn(
                "border rounded-lg overflow-hidden transition-colors cursor-pointer",
                a?.approved ? "border-primary/60 bg-primary/5" : "border-border opacity-60",
              )}
              onClick={() => toggleApprove(vid)}
            >
              <div className="relative">
                <img src={`${API_BASE}${p.imageUrl}`} alt={p.platform} className="w-full aspect-square object-cover" />
                <span className={cn(
                  "absolute top-1 left-1 text-[10px] font-bold px-1 py-0.5 rounded",
                  a?.approved ? "bg-primary text-primary-foreground" : "bg-black/50 text-white",
                )}>
                  {PLATFORM_LABELS[p.platform] || p.platform}
                </span>
                {isConverted && (
                  <span className="absolute bottom-1 left-1 text-[8px] bg-green-600 text-white px-1 py-0.5 rounded flex items-center gap-0.5">
                    <Video size={7} /> Video ready
                  </span>
                )}
                <div className={cn(
                  "absolute top-1 right-1 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center",
                  a?.approved ? "bg-primary border-primary text-white" : "bg-transparent border-white/60",
                )}>
                  {a?.approved && <Check size={9} />}
                </div>
              </div>
              <div className="px-2 pb-2 pt-1 space-y-1" onClick={e => e.stopPropagation()}>
                <p className="text-[10px] text-muted-foreground line-clamp-2">{p.caption}</p>
                {a?.approved && (
                  <input
                    type="datetime-local"
                    value={dtLocal}
                    onChange={e => setTime(vid, e.target.value)}
                    className="text-[10px] w-full border border-border rounded px-1 py-0.5 bg-background"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {approvedPlatforms.length > 0 && (
        <button
          onClick={handleSchedule}
          className="w-full text-xs h-8 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center justify-center gap-1.5"
        >
          <Calendar size={11} />
          Schedule {approvedPlatforms.length} post{approvedPlatforms.length !== 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}
