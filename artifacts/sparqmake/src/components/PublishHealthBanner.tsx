import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useCanWrite } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCw, Loader2, CheckCircle2, MailWarning } from "lucide-react";
import { PlatformIcon } from "@/components/ui/platform-icon";

const API_BASE = import.meta.env.VITE_API_URL || "";

export interface PublishFailure {
  id: string;
  creativeId: string;
  platform: string;
  scheduledAt: string;
  publishError: string | null;
  retryCount: number;
  socialAccountId: string | null;
  creativeName: string;
  accountName: string | null;
  permanent: boolean;
}

export interface PublishHealth {
  failedCount: number;
  permanentCount: number;
  failures: PublishFailure[];
  alerts: {
    id: string;
    entryCount: number;
    channel: string;
    recipientCount: number;
    status: string;
    summary: string | null;
    sentAt: string;
    accountName: string | null;
  }[];
  emailConfigured: boolean;
}

export function usePublishHealth() {
  const [health, setHealth] = useState<PublishHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/publish-health`);
      if (resp.ok) {
        setHealth(await resp.json());
      }
    } catch {
      // Silent — health widget is non-critical.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { health, loading, refresh };
}

export function useRetryEntry(onDone?: () => void | Promise<void>) {
  const { toast } = useToast();
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const retry = useCallback(async (id: string) => {
    setRetryingId(id);
    try {
      const resp = await apiFetch(`${API_BASE}/api/calendar-entries/${id}/retry`, { method: "POST" });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || e.message || `Failed (${resp.status})`);
      }
      toast({ title: "Retry started", description: "The post was re-queued for publishing." });
      await onDone?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Retry failed", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setRetryingId(null);
    }
  }, [onDone, toast]);

  return { retry, retryingId };
}

function FailureRow({ failure, canWrite, retryingId, onRetry }: {
  failure: PublishFailure;
  canWrite: boolean;
  retryingId: string | null;
  onRetry: (id: string) => void;
}) {
  const when = new Date(failure.scheduledAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className="flex items-center gap-2 min-w-0" data-testid={`row-publish-failure-${failure.id}`}>
      <PlatformIcon platform={failure.platform} className="w-3.5 h-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-foreground truncate">
          <span className="font-medium">{failure.creativeName}</span>
          {failure.accountName && <span className="text-muted-foreground"> · {failure.accountName}</span>}
          <span className="text-muted-foreground"> · {when}</span>
        </p>
        <p className="text-xs text-destructive truncate" title={failure.publishError || undefined}>
          {failure.publishError || "Unknown error"}
          {failure.permanent && <span className="text-muted-foreground"> — won't retry automatically</span>}
        </p>
      </div>
      {canWrite && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs shrink-0"
          disabled={retryingId === failure.id}
          onClick={() => onRetry(failure.id)}
          data-testid={`button-retry-${failure.id}`}
        >
          {retryingId === failure.id ? <Loader2 size={12} className="mr-1 animate-spin" /> : <RotateCw size={12} className="mr-1" />}
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * Prominent banner listing failed scheduled publishes with a one-click retry.
 * Renders nothing while loading or when there are no failures.
 */
export function PublishHealthBanner({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const canWrite = useCanWrite();
  const { health, refresh } = usePublishHealth();
  const { retry, retryingId } = useRetryEntry(async () => {
    await refresh();
    await onChanged?.();
  });

  if (!health || health.failedCount === 0) return null;

  const shown = health.failures.slice(0, 5);

  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 sm:p-4 space-y-2" data-testid="banner-publish-health">
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-destructive shrink-0" />
        <p className="text-sm font-semibold text-foreground">
          {health.failedCount} scheduled post{health.failedCount === 1 ? "" : "s"} failed to publish
          {health.permanentCount > 0 && (
            <span className="font-normal text-muted-foreground"> ({health.permanentCount} won't retry automatically)</span>
          )}
        </p>
      </div>
      <div className="space-y-1.5 pl-6">
        {shown.map((f) => (
          <FailureRow key={f.id} failure={f} canWrite={canWrite} retryingId={retryingId} onRetry={retry} />
        ))}
        {health.failures.length > shown.length && (
          <p className="text-xs text-muted-foreground">+{health.failures.length - shown.length} more — see Calendar</p>
        )}
      </div>
      {!health.emailConfigured && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground pl-6" data-testid="text-email-not-configured">
          <MailWarning size={12} className="shrink-0" />
          Email alerts are not configured — set SMTP_HOST and SMTP_FROM to notify admins automatically.
        </p>
      )}
    </div>
  );
}

/**
 * Compact "Publish health" card for the admin dashboard. Always renders:
 * green when everything published, red list of recent failures otherwise.
 */
export function PublishHealthCard() {
  const canWrite = useCanWrite();
  const { health, loading, refresh } = usePublishHealth();
  const { retry, retryingId } = useRetryEntry(refresh);

  return (
    <div className="bg-card border border-border rounded-xl p-4 sm:p-6" data-testid="card-publish-health">
      <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
        {health && health.failedCount > 0 ? (
          <AlertTriangle size={16} className="text-destructive" />
        ) : (
          <CheckCircle2 size={16} className="text-green-400" />
        )}
        Publish Health
      </h3>
      {loading ? (
        <div className="h-16 animate-pulse rounded bg-muted/40" />
      ) : !health || health.failedCount === 0 ? (
        <p className="text-sm text-muted-foreground">No failed publishes. All scheduled posts are healthy.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {health.failedCount} failed post{health.failedCount === 1 ? "" : "s"}
            {health.permanentCount > 0 && ` · ${health.permanentCount} need attention`}
          </p>
          <div className="space-y-1.5">
            {health.failures.slice(0, 4).map((f) => (
              <FailureRow key={f.id} failure={f} canWrite={canWrite} retryingId={retryingId} onRetry={retry} />
            ))}
          </div>
          {health.alerts.length > 0 && (
            <p className="text-[10px] text-muted-foreground pt-1">
              Last alert: {new Date(health.alerts[0].sentAt).toLocaleString()} ({health.alerts[0].status}, {health.alerts[0].entryCount} post{health.alerts[0].entryCount === 1 ? "" : "s"})
            </p>
          )}
          {!health.emailConfigured && (
            <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <MailWarning size={11} className="shrink-0" />
              Email alerts not configured (set SMTP_HOST / SMTP_FROM)
            </p>
          )}
        </div>
      )}
    </div>
  );
}
