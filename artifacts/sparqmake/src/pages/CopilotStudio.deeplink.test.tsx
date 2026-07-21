/**
 * Deep-link flow tests: ?campaign= plan-item links surviving login redirects.
 *
 * Covers:
 *  1. AuthGate preserves the query string in returnTo when redirecting to /login.
 *  2. Login's sanitizeReturnTo keeps relative paths with query strings.
 *  3. CopilotStudio's mount effect consumes ?campaign= and auto-starts a session
 *     (as happens on a fresh mount after the returnTo redirect).
 *  4. If session auto-start fails (creative deleted), a clear error toast is
 *     shown and the user lands on the Studio home, not a blank screen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
  toast: (...args: unknown[]) => toastMock(...args),
}));

const authState = {
  authenticated: false,
  user: null as unknown,
  loading: false,
  refresh: vi.fn(),
  logout: vi.fn(),
};
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useCanWrite: () => true,
  useIsAdmin: () => false,
  roleCanWrite: () => true,
  roleIsAdmin: () => false,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetBrands: () => ({ data: [], isLoading: false }),
  useGetStyleProfiles: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/components/DesignersTab", () => ({
  useDesignerPersonas: () => ({ personas: [] }),
}));

const apiFetchMock = vi.fn();
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

import { AuthGate } from "@/App";
import { sanitizeReturnTo } from "@/pages/Login";
import CopilotStudio from "@/pages/CopilotStudio";

function setUrl(path: string) {
  window.history.replaceState({}, "", path);
}

beforeEach(() => {
  toastMock.mockReset();
  apiFetchMock.mockReset();
  authState.authenticated = false;
  authState.loading = false;
});

describe("AuthGate returnTo", () => {
  it("preserves the ?campaign= query string when redirecting to login", async () => {
    setUrl("/?campaign=camp-1&platform=twitter");
    const { hook, history } = memoryLocation({ path: "/?campaign=camp-1&platform=twitter", record: true });
    render(
      <Router hook={hook}>
        <AuthGate>
          <div>protected</div>
        </AuthGate>
      </Router>,
    );
    await waitFor(() => {
      const last = history[history.length - 1];
      expect(last).toContain("/login?returnTo=");
    });
    const last = history[history.length - 1]!;
    const returnTo = new URLSearchParams(last.split("?")[1]).get("returnTo");
    expect(returnTo).toBe("/?campaign=camp-1&platform=twitter");
    expect(screen.queryByText("protected")).not.toBeInTheDocument();
  });

  it("renders children when authenticated", () => {
    authState.authenticated = true;
    setUrl("/?campaign=camp-1");
    const { hook } = memoryLocation({ path: "/?campaign=camp-1" });
    render(
      <Router hook={hook}>
        <AuthGate>
          <div>protected</div>
        </AuthGate>
      </Router>,
    );
    expect(screen.getByText("protected")).toBeInTheDocument();
  });
});

describe("Login sanitizeReturnTo", () => {
  it("keeps relative paths with query strings", () => {
    expect(sanitizeReturnTo("/?campaign=camp-1&platform=twitter")).toBe(
      "/?campaign=camp-1&platform=twitter",
    );
  });
  it("rejects absolute/protocol-relative URLs", () => {
    expect(sanitizeReturnTo("//evil.com/?campaign=x")).toBe("/");
    expect(sanitizeReturnTo("https://evil.com")).toBe("/");
    expect(sanitizeReturnTo(null)).toBe("/");
  });
});

describe("CopilotStudio ?campaign= deep-link", () => {
  it("auto-starts a session from the campaign param on mount", async () => {
    setUrl("/?campaign=camp-1&platform=twitter");
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/creatives/camp-1") && !url.includes("/variants")) {
        return {
          ok: true,
          json: async () => ({ brandId: "brand-1", briefText: "Rivalry week", intent: "hype" }),
        };
      }
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return { ok: true, json: async () => ({ id: "sess-1" }) };
      }
      if (url.includes("/api/sessions/sess-1")) {
        return {
          ok: true,
          json: async () => ({
            session: {
              id: "sess-1", brandId: "brand-1", creativeId: "camp-1", status: "drafting",
              activeVariantId: null, imageInteractionId: null, videoInteractionId: null,
              sessionTitle: "Rivalry week", lastTurnSummary: null, thumbnailUrl: null,
              totalCostUsd: 0, createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z",
            },
            turns: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<CopilotStudio />);

    await waitFor(() => {
      const post = apiFetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/sessions") && (i as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
    });
    const post = apiFetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/sessions") && (i as RequestInit)?.method === "POST",
    )!;
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body.brandId).toBe("brand-1");
    expect(body.briefText).toContain("Rivalry week");
    expect(body.briefText).toContain("Target platform: twitter");
    expect(body.intent).toBe("hype");

    // Params are consumed: removed from the URL so refresh won't re-trigger.
    await waitFor(() => {
      expect(window.location.search).not.toContain("campaign");
      expect(window.location.search).not.toContain("platform");
    });

    // Session view loads (not stuck on the seeding spinner, not Home).
    await waitFor(() => {
      expect(
        apiFetchMock.mock.calls.some(([u]) => String(u).includes("/api/sessions/sess-1")),
      ).toBe(true);
    });
    expect(screen.queryByText("Opening your plan item...")).not.toBeInTheDocument();
    expect(screen.queryByText("Co-pilot Studio")).not.toBeInTheDocument();
  });

  it("shows a clear error and lands on Studio home when the creative is gone", async () => {
    setUrl("/?campaign=deleted-camp");
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/api/creatives/deleted-camp")) {
        return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
      }
      return { ok: true, json: async () => ({ data: [], sessions: [], concepts: [] }) };
    });

    render(<CopilotStudio />);

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Could not open plan item",
        }),
      );
    });

    // Lands on Studio home, not a blank screen.
    await waitFor(() => {
      expect(screen.getByText("Co-pilot Studio")).toBeInTheDocument();
    });
  });

  it("does not re-consume a stale campaign param once a session is open (session link wins)", async () => {
    setUrl("/?session=sess-9&campaign=camp-2");
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/api/sessions/sess-9")) {
        return {
          ok: true,
          json: async () => ({
            session: {
              id: "sess-9", brandId: "b", creativeId: "c", status: "drafting",
              activeVariantId: null, imageInteractionId: null, videoInteractionId: null,
              sessionTitle: null, lastTurnSummary: null, thumbnailUrl: null,
              totalCostUsd: 0, createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z",
            },
            turns: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<CopilotStudio />);

    await waitFor(() => {
      expect(
        apiFetchMock.mock.calls.some(([u]) => String(u).includes("/api/sessions/sess-9")),
      ).toBe(true);
    });
  });
});
