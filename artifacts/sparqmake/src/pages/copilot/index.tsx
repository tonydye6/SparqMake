/**
 * Root Co-pilot Studio component.
 *
 * URL contract:
 *   ?campaign=<creativeId>  — deep-link from ContentPlan; auto-creates a session
 *   ?platform=<name>        — carried from the plan item to pre-fill the brief
 *   ?session=<id>           — direct link / reload restore
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { useCanWrite } from "@/hooks/useAuth";
import { Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { HomeView } from "./HomeView";
import { SessionView } from "./SessionView";
import { API_BASE } from "./types";

export default function CopilotStudio() {
  const { toast } = useToast();
  const canWrite = useCanWrite();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [autoDraftBrief, setAutoDraftBrief] = useState<string | null>(null);

  // Read URL params once on mount
  const { campaignId, urlSessionId, urlPlatform } = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      campaignId: params.get("campaign"),
      urlSessionId: params.get("session"),
      urlPlatform: params.get("platform"),
    };
  })[0];

  const openSession = useCallback((id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("session", id);
    window.history.replaceState({}, "", url.toString());
    setSessionId(id);
  }, []);

  // Consume-once guard so Back does not re-open the URL session
  const urlSessionConsumedRef = useRef(false);

  const closeSession = useCallback(() => {
    urlSessionConsumedRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    window.history.replaceState({}, "", url.toString());
    setSessionId(null);
    setAutoDraftBrief(null);
  }, []);

  // Direct session link / reload restore
  useEffect(() => {
    if (urlSessionId && !sessionId && !seeding && !urlSessionConsumedRef.current) {
      urlSessionConsumedRef.current = true;
      setSessionId(urlSessionId);
    }
  }, [urlSessionId, sessionId, seeding]);

  // Deep-link from ContentPlan
  const seedAttemptedRef = useRef(false);
  useEffect(() => {
    if (!canWrite) return;
    if (!campaignId || urlSessionId || sessionId || seeding || seedAttemptedRef.current) return;
    seedAttemptedRef.current = true;
    setSeeding(true);
    void (async () => {
      try {
        const cResp = await apiFetch(`${API_BASE}/api/creatives/${campaignId}`);
        if (!cResp.ok) throw new Error("Creative not found");
        const creative = await cResp.json() as {
          brandId: string;
          briefText: string | null;
          intent: string | null;
        };

        const baseBrief = creative.briefText?.trim() || "New content";
        const briefText = urlPlatform
          ? `${baseBrief}\nTarget platform: ${urlPlatform}`
          : baseBrief;
        const sResp = await apiFetch(`${API_BASE}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brandId: creative.brandId,
            briefText,
            intent: creative.intent || undefined,
            existingCreativeId: campaignId,
          }),
        });
        if (!sResp.ok) {
          const e = await sResp.json().catch(() => ({})) as { error?: string };
          throw new Error(e.error || "Could not start session");
        }
        const session = await sResp.json() as { id: string };

        const url = new URL(window.location.href);
        url.searchParams.delete("campaign");
        url.searchParams.delete("platform");
        window.history.replaceState({}, "", url.toString());
        openSession(session.id);
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Could not open plan item",
          description: err instanceof Error ? err.message : "Please try again.",
        });
      } finally {
        setSeeding(false);
      }
    })();
  }, [campaignId, urlSessionId, urlPlatform, sessionId, seeding, toast, openSession, canWrite]);

  if (seeding) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Opening your plan item...</p>
        </div>
      </div>
    );
  }

  if (sessionId) {
    return (
      <SessionView
        sessionId={sessionId}
        autoDraftBrief={autoDraftBrief}
        onBack={closeSession}
      />
    );
  }

  return (
    <HomeView
      onSessionCreated={(id, brief) => {
        setAutoDraftBrief(brief ?? null);
        openSession(id);
      }}
    />
  );
}
