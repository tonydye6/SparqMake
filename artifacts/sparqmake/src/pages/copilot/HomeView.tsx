import { useState, useCallback, useEffect } from "react";
import { useCanWrite } from "@/hooks/useAuth";
import { Sparkles, Bot, RotateCcw, Image as ImageIcon, ArrowRight, Loader2 } from "lucide-react";
import { useGetBrands, useGetStyleProfiles } from "@workspace/api-client-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDesignerPersonas } from "@/components/DesignersTab";
import type { Concept, SessionSummary, Session } from "./types";
import { API_BASE } from "./types";

interface HomeViewProps {
  onSessionCreated: (sessionId: string, autoDraftBrief?: string) => void;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    drafting: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400",
    refining: "bg-blue-500/20 text-blue-700 dark:text-blue-400",
    shipped: "bg-green-500/20 text-green-700 dark:text-green-400",
    archived: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn("text-xs px-1.5 py-0.5 rounded-full font-medium", map[status] || map["drafting"])}>
      {status}
    </span>
  );
}

export function HomeView({ onSessionCreated }: HomeViewProps) {
  const { toast } = useToast();
  const canWrite = useCanWrite();
  const { data: brands, isLoading: brandsLoading } = useGetBrands();
  const { personas } = useDesignerPersonas();
  const [brandId, setBrandId] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [styleProfileId, setStyleProfileId] = useState<string | null>(null);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [loadingConcepts, setLoadingConcepts] = useState(false);
  const [creating, setCreating] = useState(false);
  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);

  const { data: styleProfiles } = useGetStyleProfiles(brandId ?? "", {
    query: { enabled: Boolean(brandId) } as Parameters<typeof useGetStyleProfiles>[1] extends { query?: infer Q } ? Q : never,
  });

  useEffect(() => {
    if (!brandId && brands && brands.length > 0) {
      setBrandId(brands[0].id);
    }
  }, [brandId, brands]);

  useEffect(() => {
    if (!styleProfileId && styleProfiles?.length) {
      const def = styleProfiles.find(p => p.isDefault);
      if (def) setStyleProfileId(def.id);
    }
  }, [styleProfiles, styleProfileId]);

  const loadConcepts = useCallback(async (bid: string) => {
    setLoadingConcepts(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/concept-suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId: bid, briefText: brief.trim() || undefined }),
      });
      if (!resp.ok) throw new Error("Could not load concepts");
      const data = await resp.json();
      setConcepts(Array.isArray(data.concepts) ? data.concepts : []);
    } catch {
      setConcepts([]);
    } finally {
      setLoadingConcepts(false);
    }
  }, [brief]);

  useEffect(() => {
    if (brandId) void loadConcepts(brandId);
  }, [brandId, loadConcepts]);

  const loadRecentSessions = useCallback(async (bid: string) => {
    setLoadingRecent(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/sessions?brandId=${bid}&limit=6`);
      if (!resp.ok) return;
      const data = await resp.json();
      setRecentSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch {
      setRecentSessions([]);
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  useEffect(() => {
    if (brandId) void loadRecentSessions(brandId);
  }, [brandId, loadRecentSessions]);

  const startSession = useCallback(async (concept?: Concept) => {
    if (!brandId) return;
    const briefText = concept?.angle || brief.trim();
    if (!briefText) {
      toast({ variant: "destructive", title: "Brief required", description: "Enter a brief or pick a concept card." });
      return;
    }
    setCreating(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandId,
          briefText,
          conceptId: concept?.id,
          intent: concept?.intent,
          styleProfileId: styleProfileId || undefined,
          personaId: personaId || undefined,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || "Failed to start session");
      }
      const session = await resp.json() as Session;
      onSessionCreated(session.id, concept ? briefText : undefined);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not start session",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setCreating(false);
    }
  }, [brandId, brief, styleProfileId, personaId, toast, onSessionCreated]);

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex-1 max-w-4xl mx-auto w-full px-6 py-8 space-y-8">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Bot size={22} className="text-primary" />
            <h1 className="text-2xl font-bold font-display">Co-pilot Studio</h1>
            <Badge variant="outline" className="text-xs">beta</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Image-aware captions, preserving edits, branching history. Every turn shows the model what it did.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Brand</label>
            {brandsLoading ? <Skeleton className="h-9 w-full" /> : (
              <Select value={brandId || ""} onValueChange={setBrandId}>
                <SelectTrigger><SelectValue placeholder="Select brand" /></SelectTrigger>
                <SelectContent>
                  {(brands || []).map(b => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Style Profile</label>
            <Select value={styleProfileId || "none"} onValueChange={v => setStyleProfileId(v === "none" ? null : v)}>
              <SelectTrigger><SelectValue placeholder="No style" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No style</SelectItem>
                {(styleProfiles || []).map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.name}{p.isDefault ? " (default)" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Designer Persona</label>
            <Select value={personaId || "none"} onValueChange={v => setPersonaId(v === "none" ? null : v)}>
              <SelectTrigger><SelectValue placeholder="No persona" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No persona</SelectItem>
                {personas.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {canWrite ? (
          <>
            <div className="space-y-3">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Brief</label>
              <div className="flex gap-2">
                <Textarea
                  value={brief}
                  onChange={e => setBrief(e.target.value)}
                  placeholder="Week 3 rivalry vs Ironclad U, playful trash talk..."
                  rows={3}
                  className="resize-none flex-1"
                  onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void startSession(); }}
                />
                <Button
                  disabled={creating || !brandId}
                  onClick={() => void startSession()}
                  className="self-end"
                >
                  {creating ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  Start
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Or pick a concept</label>
                {brandId && (
                  <button
                    onClick={() => void loadConcepts(brandId)}
                    disabled={loadingConcepts}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    <RotateCcw size={12} className={loadingConcepts ? "animate-spin" : ""} />
                    Refresh
                  </button>
                )}
              </div>

              {loadingConcepts ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[0, 1, 2].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {concepts.map(c => (
                    <button
                      key={c.id}
                      onClick={() => void startSession(c)}
                      disabled={creating || !brandId}
                      className="text-left p-4 border border-border rounded-lg hover:border-primary/60 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="text-sm font-medium mb-1 group-hover:text-primary transition-colors">{c.title}</div>
                      <div className="text-xs text-muted-foreground line-clamp-2">{c.angle}</div>
                      {c.intentLabel && (
                        <Badge variant="secondary" className="mt-2 text-xs">{c.intentLabel}</Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-5 text-sm text-muted-foreground">
            You have view-only access to this brand. Contact an editor or admin to start new Co-pilot sessions.
          </div>
        )}

        {(recentSessions.length > 0 || loadingRecent) && (
          <div className="space-y-3 border-t border-border pt-8">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Continue a session</label>
            {loadingRecent ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[0, 1, 2].map(i => <Skeleton key={i} className="h-20 rounded-lg" />)}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {recentSessions.map(s => (
                  <button
                    key={s.id}
                    onClick={() => onSessionCreated(s.id)}
                    className="text-left flex gap-3 p-3 border border-border rounded-lg hover:border-primary/60 hover:bg-primary/5 transition-colors"
                  >
                    {s.thumbnailUrl ? (
                      <img src={s.thumbnailUrl} alt="" className="w-14 h-14 rounded object-cover shrink-0" />
                    ) : (
                      <div className="w-14 h-14 rounded bg-muted flex items-center justify-center shrink-0">
                        <ImageIcon size={18} className="text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{s.sessionTitle || "Untitled session"}</div>
                      <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{s.lastTurnSummary || "No turns yet"}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <StatusBadge status={s.status} />
                        <span className="text-xs text-muted-foreground">${s.totalCostUsd?.toFixed(3) || "0.00"}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
