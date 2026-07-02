import { useState, useEffect, useCallback } from "react";
import { getCalendarEntries } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Send, RotateCw, Loader2 } from "lucide-react";
import { PublishHealthBanner } from "@/components/PublishHealthBanner";
import { FaInstagram, FaXTwitter, FaTiktok, FaLinkedin, FaYoutube } from "react-icons/fa6";
import type { IconType } from "react-icons";

const API_BASE = import.meta.env.VITE_API_URL || "";

const PLATFORM_ICONS: Record<string, IconType> = {
  instagram: FaInstagram,
  instagram_feed: FaInstagram,
  instagram_story: FaInstagram,
  twitter: FaXTwitter,
  x: FaXTwitter,
  tiktok: FaTiktok,
  linkedin: FaLinkedin,
  youtube: FaYoutube,
};

interface CalEntry {
  id: string;
  creativeId: string;
  variantId: string;
  platform: string;
  scheduledAt: string;
  publishStatus: string;
  publishError?: string | null;
  retryCount?: number;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  published: "default",
  scheduled: "secondary",
  publishing: "secondary",
  failed: "destructive",
};

export default function CalendarNext() {
  const { toast } = useToast();
  const [entries, setEntries] = useState<CalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      const end = new Date(now);
      end.setDate(end.getDate() + 60);
      const data = await getCalendarEntries({ start: start.toISOString(), end: end.toISOString() });
      const arr = ((data as { entries?: CalEntry[]; data?: CalEntry[] })?.entries ||
        (data as { data?: CalEntry[] })?.data ||
        (Array.isArray(data) ? (data as CalEntry[]) : [])) as CalEntry[];
      arr.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
      setEntries(arr);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: "publish" | "retry") {
    setBusyId(id);
    try {
      const resp = await apiFetch(`${API_BASE}/api/calendar-entries/${id}/${action}`, { method: "POST" });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || e.message || `Failed (${resp.status})`);
      }
      await load();
      toast({ title: action === "publish" ? "Publishing" : "Retrying" });
    } catch (err) {
      toast({ variant: "destructive", title: "Action failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setBusyId(null);
    }
  }

  // Group entries by day for the agenda.
  const groups: { date: string; items: CalEntry[] }[] = [];
  for (const e of entries) {
    const d = new Date(e.scheduledAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    let g = groups.find((x) => x.date === d);
    if (!g) {
      g = { date: d, items: [] };
      groups.push(g);
    }
    g.items.push(e);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-16 border-b border-border flex items-center gap-3 px-6 shrink-0">
        <h1 className="font-display text-lg font-semibold text-foreground">Calendar</h1>
        <span className="ml-auto text-xs text-muted-foreground">{entries.length} scheduled · agenda</span>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <div className="mb-6 empty:mb-0">
            <PublishHealthBanner onChanged={load} />
          </div>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="text-center text-muted-foreground py-16">
              Nothing scheduled. Approve a platform set in Fan-out, then schedule it here.
            </div>
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <div key={g.date} className="space-y-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.date}</h2>
                  {g.items.map((e) => {
                    const Icon = PLATFORM_ICONS[e.platform];
                    const time = new Date(e.scheduledAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
                    return (
                      <Card key={e.id} className="flex items-center gap-3 p-3">
                        <span className="text-sm font-medium text-foreground w-16 shrink-0">{time}</span>
                        {Icon && <Icon size={16} className="text-foreground shrink-0" />}
                        <div className="min-w-0 flex-1">
                          <Badge variant={STATUS_VARIANT[e.publishStatus] || "secondary"} className="text-[10px]">{e.publishStatus}</Badge>
                          {e.publishError && <p className="text-xs text-destructive truncate mt-0.5">{e.publishError}</p>}
                        </div>
                        {(e.publishStatus === "scheduled" || e.publishStatus === "failed") && (
                          <Button
                            size="sm"
                            variant={e.publishStatus === "failed" ? "outline" : "default"}
                            className="h-7 px-2 text-xs"
                            disabled={busyId === e.id}
                            onClick={() => act(e.id, e.publishStatus === "failed" ? "retry" : "publish")}
                          >
                            {busyId === e.id ? (
                              <Loader2 size={12} className="mr-1 animate-spin" />
                            ) : e.publishStatus === "failed" ? (
                              <RotateCw size={12} className="mr-1" />
                            ) : (
                              <Send size={12} className="mr-1" />
                            )}
                            {e.publishStatus === "failed" ? "Retry" : "Publish now"}
                          </Button>
                        )}
                      </Card>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
