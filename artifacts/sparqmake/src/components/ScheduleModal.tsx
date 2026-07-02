import { apiFetch } from "@/lib/utils";
import { useState, useEffect } from "react";
import { AlertTriangle, CalendarIcon, Clock, Send } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { PlatformIcon } from "@/components/ui/platform-icon";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface SocialAccount {
  id: string;
  platform: string;
  accountName: string;
  accountId: string;
  status: string;
  displayStatus?: string;
}

const UNHEALTHY_STATUSES = new Set(["expired", "needs_reconnect", "revoked"]);

function accountHealth(acc: SocialAccount): string {
  return acc.displayStatus || acc.status;
}

interface ScheduleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creativeId: string;
  creativeName: string;
  onScheduled?: () => void;
}

const PLATFORM_MAP: Record<string, string> = {
  twitter: "twitter",
  instagram_feed: "instagram",
  instagram_story: "instagram",
  linkedin: "linkedin",
  tiktok: "tiktok",
  youtube: "youtube",
};

export function ScheduleModal({ open, onOpenChange, creativeId, creativeName, onScheduled }: ScheduleModalProps) {
  const { toast } = useToast();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("12:00");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [socialAccounts, setSocialAccounts] = useState<SocialAccount[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      apiFetch(`${API_BASE}/api/social-accounts`)
        .then(res => res.json())
        .then(data => setSocialAccounts(data || []))
        .catch(() => setSocialAccounts([]));
    }
  }, [open]);

  const accountsByPlatform = socialAccounts.reduce<Record<string, SocialAccount[]>>((acc, account) => {
    if (!acc[account.platform]) acc[account.platform] = [];
    acc[account.platform].push(account);
    return acc;
  }, {});

  const handleAccountSelect = (platform: string, accountId: string) => {
    setSelectedAccounts(prev => ({
      ...prev,
      [platform]: accountId === "none" ? "" : accountId,
    }));
  };

  const handleSchedule = async () => {
    if (!date || !time) {
      toast({ variant: "destructive", title: "Select a date and time" });
      return;
    }

    const scheduledAt = new Date(`${date}T${time}:00`).toISOString();

    setIsSubmitting(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledAt, socialAccounts: selectedAccounts }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Failed to schedule" }));
        throw new Error(err.error);
      }

      const data = await resp.json();
      toast({ title: "Scheduled!", description: `${data.count} variant(s) scheduled for ${new Date(scheduledAt).toLocaleString()}` });
      onOpenChange(false);
      onScheduled?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Schedule failed", description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minDate = tomorrow.toISOString().split("T")[0];

  const platforms = Object.keys(PLATFORM_MAP);
  const hasSocialAccounts = socialAccounts.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-foreground flex items-center gap-2">
            <CalendarIcon size={18} className="text-primary" />
            Schedule Creative
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Set a publish date and time for "{creativeName}"
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</label>
            <Input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              min={minDate}
              className="bg-background border-border"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Time</label>
            <div className="relative">
              <Clock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="time"
                value={time}
                onChange={e => setTime(e.target.value)}
                className="bg-background border-border pl-9"
              />
            </div>
          </div>

          {hasSocialAccounts && (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Publish To (Optional)</label>
              <p className="text-[11px] text-muted-foreground">Select accounts for auto-publishing when scheduled time arrives</p>
              <div className="space-y-2">
                {platforms.map(platform => {
                  const mappedPlatform = PLATFORM_MAP[platform];
                  const accounts = accountsByPlatform[mappedPlatform] || accountsByPlatform[platform] || [];
                  if (accounts.length === 0) return null;

                  const platformLabel = platform === "twitter" ? "X/Twitter" :
                    platform === "instagram_feed" ? "Instagram Feed" :
                    platform === "instagram_story" ? "Instagram Story" :
                    platform === "linkedin" ? "LinkedIn" :
                    platform === "tiktok" ? "TikTok" :
                    platform === "youtube" ? "YouTube" : platform;

                  const healthyAccounts = accounts.filter(acc => {
                    const health = accountHealth(acc);
                    return health === "connected" || health === "expiring";
                  });
                  const unhealthyCount = accounts.filter(acc => UNHEALTHY_STATUSES.has(accountHealth(acc))).length;
                  const selectedAccount = accounts.find(acc => acc.id === selectedAccounts[platform]);
                  const selectedExpiring = selectedAccount && accountHealth(selectedAccount) === "expiring";

                  return (
                    <div key={platform} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <PlatformIcon platform={mappedPlatform} className="w-4 h-4 opacity-70 shrink-0" />
                        <span className="text-xs text-muted-foreground w-24 shrink-0">{platformLabel}</span>
                        <Select
                          value={selectedAccounts[platform] || "none"}
                          onValueChange={(val) => handleAccountSelect(platform, val)}
                        >
                          <SelectTrigger className="flex-1 h-8 text-xs bg-background border-border">
                            <SelectValue placeholder="No account" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No auto-publish</SelectItem>
                            {healthyAccounts.map(acc => (
                              <SelectItem key={acc.id} value={acc.id}>
                                {acc.accountName} ({acc.accountId})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {unhealthyCount > 0 && (
                        <p className="flex items-start gap-1 text-[11px] text-red-500 pl-6" data-testid={`warning-connection-${platform}`}>
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                          {healthyAccounts.length === 0
                            ? `${platformLabel} connection needs reconnecting — auto-publish will fail until you reconnect it in Settings → Connected Accounts.`
                            : `${unhealthyCount} ${platformLabel} account${unhealthyCount > 1 ? "s" : ""} need${unhealthyCount > 1 ? "" : "s"} reconnecting and ${unhealthyCount > 1 ? "are" : "is"} hidden from this list.`}
                        </p>
                      )}
                      {selectedExpiring && (
                        <p className="flex items-start gap-1 text-[11px] text-amber-500 pl-6" data-testid={`warning-expiring-${platform}`}>
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                          This account's token is expiring soon. It should refresh automatically, but check Settings if the post doesn't publish.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {date && time && (
            <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-sm">
              <span className="text-muted-foreground">All variants will be scheduled for:</span>
              <p className="font-semibold text-foreground mt-1">
                {new Date(`${date}T${time}:00`).toLocaleString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="bg-card border-border">
            Cancel
          </Button>
          <Button
            onClick={handleSchedule}
            disabled={!date || !time || isSubmitting}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {isSubmitting ? "Scheduling..." : <><Send size={14} className="mr-2" /> Schedule</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
