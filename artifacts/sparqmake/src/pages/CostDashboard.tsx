import { apiFetch } from "@/lib/utils";
import { useState, useEffect } from "react";
import { DollarSign, TrendingUp, Zap, BarChart3, Calendar as CalendarIcon, AlertTriangle, Settings, Shield, Save } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { PublishHealthCard } from "@/components/PublishHealthBanner";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface CostSummary {
  totalCost: number;
  totalEntries: number;
  byService: Array<{ service: string; totalCost: number; count: number }>;
  byOperation: Array<{ operation: string; service: string; totalCost: number; count: number }>;
  dailySpend: Array<{ date: string; totalCost: number; count: number }>;
}

interface CostLogEntry {
  id: string;
  creativeId: string | null;
  service: string;
  operation: string;
  model: string | null;
  costUsd: number;
  createdAt: string;
}

interface BudgetStatus {
  threshold: number | null;
  todaySpend: number;
  remaining: number | null;
  overBudget: boolean;
  nearLimit?: boolean;
}

const SERVICE_COLORS: Record<string, string> = {
  anthropic: "#D97757",
  gemini: "#4285F4",
  elevenlabs: "#00C9A7",
};

const SERVICE_LABELS: Record<string, string> = {
  anthropic: "Claude (Anthropic)",
  gemini: "Gemini / Imagen / Veo",
  elevenlabs: "ElevenLabs",
};

export default function CostDashboard() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [recentLogs, setRecentLogs] = useState<CostLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dateRange, setDateRange] = useState<"7d" | "30d" | "90d" | "all">("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [budgetStatus, setBudgetStatus] = useState<BudgetStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [thresholdInput, setThresholdInput] = useState("");
  const [savingThreshold, setSavingThreshold] = useState(false);
  const { toast } = useToast();

  const getDateParams = () => {
    const now = new Date();
    let startDate: string | undefined;
    if (dateRange === "7d") {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      startDate = d.toISOString();
    } else if (dateRange === "30d") {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      startDate = d.toISOString();
    } else if (dateRange === "90d") {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      startDate = d.toISOString();
    }
    return { startDate, endDate: now.toISOString() };
  };

  const loadBudgetStatus = async () => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/settings/daily-budget-status`);
      if (resp.ok) {
        const data = await resp.json();
        setBudgetStatus(data);
        if (data.threshold !== null) {
          setThresholdInput(String(data.threshold));
        }
      }
    } catch {}
  };

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { startDate, endDate } = getDateParams();
        const params = new URLSearchParams();
        if (startDate) params.set("startDate", startDate);
        if (endDate) params.set("endDate", endDate);

        const [summaryRes, logsRes] = await Promise.all([
          apiFetch(`${API_BASE}/api/cost-logs/summary?${params}`),
          apiFetch(`${API_BASE}/api/cost-logs?${params}&limit=50`),
        ]);

        if (summaryRes.ok) setSummary(await summaryRes.json());
        if (logsRes.ok) setRecentLogs(await logsRes.json());
      } catch {}
      setIsLoading(false);
    };
    loadData();
    loadBudgetStatus();
  }, [dateRange]);

  const handleSaveThreshold = async () => {
    setSavingThreshold(true);
    try {
      const value = thresholdInput.trim();
      const numVal = parseFloat(value);

      if (value && (isNaN(numVal) || numVal < 0)) {
        toast({ variant: "destructive", title: "Invalid threshold", description: "Enter a positive number or leave empty to disable." });
        setSavingThreshold(false);
        return;
      }

      const resp = await apiFetch(`${API_BASE}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyCostThreshold: value || "0" }),
      });

      if (resp.ok) {
        toast({ title: value ? `Daily budget set to $${numVal.toFixed(2)}` : "Daily budget limit removed" });
        await loadBudgetStatus();
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to save threshold" });
    }
    setSavingThreshold(false);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col h-full overflow-hidden p-3 sm:p-6 max-w-[1200px] mx-auto w-full">
        <div className="mb-6">
          <h1 className="text-xl sm:text-3xl font-bold text-foreground">Cost Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">Track API spending across all AI services.</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-20 sm:h-24 bg-card" />)}
        </div>
        <Skeleton className="h-[300px] bg-card" />
      </div>
    );
  }

  const maxDailySpend = Math.max(...(summary?.dailySpend.map(d => d.totalCost) || [0]), 0.01);
  const avgDailyCost = summary && summary.dailySpend.length > 0
    ? summary.totalCost / summary.dailySpend.length
    : 0;

  const budgetPct = budgetStatus?.threshold
    ? Math.min((budgetStatus.todaySpend / budgetStatus.threshold) * 100, 100)
    : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden p-3 sm:p-6 max-w-[1200px] mx-auto w-full">
      <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row sm:items-center justify-between shrink-0 gap-3">
        <div>
          <h1 className="text-xl sm:text-3xl font-bold text-foreground">Cost Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">Track API spending across all AI services.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(["7d", "30d", "90d", "all"] as const).map(range => (
            <Button
              key={range}
              variant={dateRange === range ? "default" : "outline"}
              size="sm"
              className="text-xs sm:text-sm"
              onClick={() => setDateRange(range)}
            >
              {range === "all" ? "All Time" : range}
            </Button>
          ))}
          <Button
            variant={showSettings ? "default" : "outline"}
            size="sm"
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings size={14} />
          </Button>
        </div>
      </div>

      {budgetStatus && budgetStatus.threshold !== null && budgetStatus.threshold > 0 && (
        <div className={`mb-4 sm:mb-6 p-3 sm:p-4 rounded-xl border ${
          budgetStatus.overBudget
            ? "bg-red-500/10 border-red-500/30"
            : budgetStatus.nearLimit
              ? "bg-amber-500/10 border-amber-500/30"
              : "bg-green-500/10 border-green-500/30"
        }`}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {budgetStatus.overBudget ? (
                <AlertTriangle size={18} className="text-red-400 shrink-0" />
              ) : budgetStatus.nearLimit ? (
                <AlertTriangle size={18} className="text-amber-400 shrink-0" />
              ) : (
                <Shield size={18} className="text-green-400 shrink-0" />
              )}
              <div>
                <p className={`text-sm font-semibold ${
                  budgetStatus.overBudget ? "text-red-400" : budgetStatus.nearLimit ? "text-amber-400" : "text-green-400"
                }`}>
                  {budgetStatus.overBudget
                    ? "Daily Budget Exceeded"
                    : budgetStatus.nearLimit
                      ? "Approaching Daily Budget Limit"
                      : "Within Budget"}
                </p>
                <p className="text-xs text-muted-foreground">
                  ${budgetStatus.todaySpend.toFixed(2)} / ${budgetStatus.threshold.toFixed(2)} today
                  {budgetStatus.remaining !== null && budgetStatus.remaining > 0 && ` · $${budgetStatus.remaining.toFixed(2)} remaining`}
                </p>
              </div>
            </div>
            <div className="w-full sm:w-48">
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    budgetStatus.overBudget ? "bg-red-500" : budgetStatus.nearLimit ? "bg-amber-500" : "bg-green-500"
                  }`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="mb-4 sm:mb-6 bg-card border border-border rounded-xl p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Settings size={16} className="text-primary" /> Budget Settings
          </h3>
          <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
            <div className="w-full sm:w-auto">
              <label className="text-xs text-muted-foreground mb-1 block">Daily Cost Threshold (USD)</label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 10.00"
                  value={thresholdInput}
                  onChange={e => setThresholdInput(e.target.value)}
                  className="bg-background border-border w-full sm:w-40"
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">Set to 0 or leave empty to disable budget alerts.</p>
            </div>
            <Button
              size="sm"
              onClick={handleSaveThreshold}
              disabled={savingThreshold}
              className="w-full sm:w-auto"
            >
              <Save size={14} className="mr-1" />
              {savingThreshold ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto pr-0 sm:pr-2 pb-12">
        <div className="mb-4 sm:mb-6">
          <PublishHealthCard />
        </div>
        {!isLoading && (!summary || summary.totalCost === 0) && (
          <EmptyState
            icon={BarChart3}
            title="No spending data"
            description="API costs will appear here after your first generation"
            className="mb-6"
          />
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-4 sm:mb-6">
          <SummaryCard
            icon={<DollarSign size={18} />}
            label="Total Spend"
            value={`$${(summary?.totalCost || 0).toFixed(2)}`}
            color="text-primary"
          />
          <SummaryCard
            icon={<TrendingUp size={18} />}
            label="Daily Average"
            value={`$${avgDailyCost.toFixed(2)}`}
            color="text-green-400"
          />
          <SummaryCard
            icon={<Zap size={18} />}
            label="API Calls"
            value={String(summary?.totalEntries || 0)}
            color="text-amber-400"
          />
          <SummaryCard
            icon={<BarChart3 size={18} />}
            label="Services Used"
            value={String(summary?.byService.length || 0)}
            color="text-purple-400"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 mb-4 sm:mb-6">
          <div className="lg:col-span-2 bg-card border border-border rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
              <CalendarIcon size={16} className="text-primary" /> Daily Spend
            </h3>
            {summary?.dailySpend && summary.dailySpend.length > 0 ? (
              <div className="flex items-end gap-0.5 sm:gap-1 h-[150px] sm:h-[180px]">
                {summary.dailySpend.map((day, i) => {
                  const height = Math.max((day.totalCost / maxDailySpend) * 100, 2);
                  const date = new Date(day.date + "T00:00:00");
                  const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center group relative min-w-0">
                      <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-background border border-border rounded px-2 py-1 text-[10px] text-foreground opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                        ${day.totalCost.toFixed(3)} ({day.count} calls)
                      </div>
                      <div
                        className="w-full bg-primary/80 rounded-t hover:bg-primary transition-colors min-h-[2px]"
                        style={{ height: `${height}%` }}
                      />
                      {summary.dailySpend.length <= 14 && (
                        <span className="text-[8px] sm:text-[9px] text-muted-foreground mt-1 truncate w-full text-center hidden sm:block">{label}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-[150px] sm:h-[180px] flex items-center justify-center text-muted-foreground text-sm">
                No spending data for this period
              </div>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4">Spend by Service</h3>
            <div className="space-y-4">
              {summary?.byService.map(s => {
                const pct = summary.totalCost > 0 ? (s.totalCost / summary.totalCost) * 100 : 0;
                const color = SERVICE_COLORS[s.service] || "#666";
                return (
                  <div key={s.service}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-foreground">{SERVICE_LABELS[s.service] || s.service}</span>
                      <span className="text-xs text-muted-foreground">${s.totalCost.toFixed(2)}</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: color }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground">{s.count} calls · {pct.toFixed(0)}%</span>
                  </div>
                );
              })}
              {(!summary?.byService || summary.byService.length === 0) && (
                <p className="text-sm text-muted-foreground text-center py-4">No data</p>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-6">
          <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4">Spend by Operation</h3>
            <div className="space-y-2">
              {summary?.byOperation
                .sort((a, b) => b.totalCost - a.totalCost)
                .map((o, i) => (
                <div key={i} className="flex items-center justify-between p-2 bg-background rounded-lg border border-border gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className="text-[10px] font-mono shrink-0">{o.operation}</Badge>
                    <span className="text-[10px] text-muted-foreground truncate hidden sm:inline">{SERVICE_LABELS[o.service] || o.service}</span>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-sm font-semibold text-foreground">${o.totalCost.toFixed(3)}</span>
                    <span className="text-[10px] text-muted-foreground ml-2">{o.count}x</span>
                  </div>
                </div>
              ))}
              {(!summary?.byOperation || summary.byOperation.length === 0) && (
                <p className="text-sm text-muted-foreground text-center py-4">No data</p>
              )}
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4">Recent API Calls</h3>
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {recentLogs.map(log => (
                <div key={log.id} className="flex items-center justify-between p-2 text-xs border-b border-border last:border-0">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: SERVICE_COLORS[log.service] || "#666" }}
                    />
                    <span className="text-foreground truncate">{log.operation}</span>
                    {log.model && <span className="text-muted-foreground text-[10px] shrink-0 hidden sm:inline">{log.model}</span>}
                  </div>
                  <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-2">
                    <span className="font-mono text-foreground">${log.costUsd.toFixed(4)}</span>
                    <span className="text-muted-foreground text-[10px] hidden sm:inline">
                      {new Date(log.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </div>
                </div>
              ))}
              {recentLogs.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No API calls recorded</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3 sm:p-5">
      <div className={`${color} mb-1 sm:mb-2`}>{icon}</div>
      <div className="text-lg sm:text-2xl font-bold text-foreground">{value}</div>
      <div className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}
