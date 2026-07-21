import { apiFetch } from "@/lib/utils";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useState, useEffect } from "react";

import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth, AuthProvider } from "@/hooks/useAuth";
import AssetLibrary from "@/pages/AssetLibrary";
import ReviewQueue from "@/pages/ReviewQueue";
import Settings from "@/pages/Settings";
import CostDashboard from "@/pages/CostDashboard";
import PerformanceDashboard from "@/pages/PerformanceDashboard";
import ContentPlan from "@/pages/ContentPlan";
import Login from "@/pages/Login";
import SetupWizard from "@/pages/SetupWizard";
import NotFound from "@/pages/not-found";
import Terms from "@/pages/Terms";
import Privacy from "@/pages/Privacy";
import Feedback from "@/pages/Feedback";
import StudioNext from "@/pages/StudioNext";
import BrandNext from "@/pages/BrandNext";
import CalendarNext from "@/pages/CalendarNext";
import CopilotStudio from "@/pages/CopilotStudio";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5,
    },
  },
});

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { authenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center space-y-6">
          <div className="flex items-center space-x-3">
            <img
              src={`${import.meta.env.BASE_URL}images/sparq-logo.png`}
              alt="SparqMake"
              className="w-10 h-10 rounded"
            />
            <span className="font-display font-bold text-2xl text-foreground">
              SPARQ<span className="text-primary">MAKE</span>
            </span>
          </div>
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (!authenticated) {
    const currentPath = window.location.pathname;
    const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
    const relativePath = currentPath.replace(basePath, "") || "/";
    if (relativePath !== "/login") {
      // Preserve the query string (e.g. ?campaign=... deep-links from the
      // content plan) so the user lands back on the exact URL after login.
      const returnTo = `${relativePath}${window.location.search}`;
      return <Redirect to={`/login?returnTo=${encodeURIComponent(returnTo)}`} />;
    }
  }

  return <>{children}</>;
}

function CopilotRedirect() {
  const search = window.location.search;
  return <Redirect to={`/${search}`} />;
}

function FirstRunGuard({ children }: { children: React.ReactNode }) {
  const [brands, setBrands] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    apiFetch("/api/brands?limit=1", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setBrands(data.data || data || []);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load brands:", err);
        setErrored(true);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!errored && brands.length === 0) {
    return <Redirect to="/setup" />;
  }

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/terms" component={Terms} />
      <Route path="/privacy" component={Privacy} />
      <Route>
    <AuthGate>
      <Switch>
        <Route path="/login" component={Login} />
        <Route path="/setup">
          <SetupWizard />
        </Route>
        <Route path="/copilot">
          <CopilotRedirect />
        </Route>
        <Route path="/studio">
          <FirstRunGuard>
            <AppLayout><StudioNext historyMode /></AppLayout>
          </FirstRunGuard>
        </Route>
        <Route path="/">
          <FirstRunGuard>
            <AppLayout><CopilotStudio /></AppLayout>
          </FirstRunGuard>
        </Route>
        <Route path="/brand">
          <FirstRunGuard>
            <AppLayout><BrandNext /></AppLayout>
          </FirstRunGuard>
        </Route>
        <Route path="/assets">
          <AppLayout><AssetLibrary /></AppLayout>
        </Route>
        <Route path="/calendar">
          <FirstRunGuard>
            <AppLayout><CalendarNext /></AppLayout>
          </FirstRunGuard>
        </Route>
        <Route path="/content-plan">
          <AppLayout><ContentPlan /></AppLayout>
        </Route>
        <Route path="/review">
          <AppLayout><ReviewQueue /></AppLayout>
        </Route>
        <Route path="/settings">
          <AppLayout><Settings /></AppLayout>
        </Route>
        <Route path="/performance">
          <AppLayout><PerformanceDashboard /></AppLayout>
        </Route>
        <Route path="/costs">
          <AppLayout><CostDashboard /></AppLayout>
        </Route>
        <Route path="/feedback">
          <AppLayout><Feedback /></AppLayout>
        </Route>
        <Route>
          <AppLayout><NotFound /></AppLayout>
        </Route>
      </Switch>
    </AuthGate>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
