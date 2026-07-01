import type { Request, Response } from "express";
import { describe, it, expect, vi } from "vitest";

// Guards are pure role checks and never consult the dev bypass, but importing
// the route modules below pulls in auth.ts, whose module-load side effect deletes
// the dev user (a DB round-trip). Enabling the bypass makes that a no-op so the
// wiring assertions don't depend on a live database.
process.env.DEV_AUTH_BYPASS = "true";

const {
  requireStandardWrite,
  requireBulkMutation,
  requireDestructive,
  MUTATION_POLICY,
} = await import("./auth.js");

const assetsRouter = (await import("../routes/assets.js")).default;
const templatesRouter = (await import("../routes/templates.js")).default;
const brandsRouter = (await import("../routes/brands.js")).default;
const socialAccountsRouter = (await import("../routes/social-accounts.js")).default;
const hashtagSetsRouter = (await import("../routes/hashtag-sets.js")).default;
const contentPlanRouter = (await import("../routes/content-plan.js")).default;
const calendarEntriesRouter = (await import("../routes/calendar-entries.js")).default;

type Role = "viewer" | "editor" | "admin" | undefined;

function reqWithRole(role: Role): Request {
  return { user: role ? { role } : undefined, method: "POST" } as unknown as Request;
}

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

/** Run a guard and report whether it called next() (allowed) or replied 403. */
function runGuard(guard: (req: Request, res: Response, next: () => void) => void, role: Role) {
  const next = vi.fn();
  const { res, status } = mockRes();
  guard(reqWithRole(role), res, next);
  return { allowed: next.mock.calls.length > 0, status };
}

describe("mutation authorization policy", () => {
  it("classifies bulk and destructive mutations as admin-only, standard writes as editor", () => {
    expect(MUTATION_POLICY).toEqual({
      standardWrite: "editor",
      bulk: "admin",
      destructive: "admin",
    });
  });

  describe("requireStandardWrite (editor and above)", () => {
    it("denies a viewer with 403", () => {
      const { allowed, status } = runGuard(requireStandardWrite, "viewer");
      expect(allowed).toBe(false);
      expect(status).toHaveBeenCalledWith(403);
    });
    it("denies a request with no role (defaults to viewer)", () => {
      const { allowed, status } = runGuard(requireStandardWrite, undefined);
      expect(allowed).toBe(false);
      expect(status).toHaveBeenCalledWith(403);
    });
    it("allows an editor", () => {
      expect(runGuard(requireStandardWrite, "editor").allowed).toBe(true);
    });
    it("allows an admin", () => {
      expect(runGuard(requireStandardWrite, "admin").allowed).toBe(true);
    });
  });

  describe.each([
    ["requireBulkMutation", () => requireBulkMutation] as const,
    ["requireDestructive", () => requireDestructive] as const,
  ])("%s (admin-only)", (_name, getGuard) => {
    it("denies a viewer with 403", () => {
      const { allowed, status } = runGuard(getGuard(), "viewer");
      expect(allowed).toBe(false);
      expect(status).toHaveBeenCalledWith(403);
    });
    it("denies an editor with 403", () => {
      const { allowed, status } = runGuard(getGuard(), "editor");
      expect(allowed).toBe(false);
      expect(status).toHaveBeenCalledWith(403);
    });
    it("allows an admin", () => {
      expect(runGuard(getGuard(), "admin").allowed).toBe(true);
    });
  });
});

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: unknown }[];
  };
}

/** True when the router has a route for `method path` guarded by `guard`. */
function routeHasGuard(
  router: { stack: RouteLayer[] },
  method: string,
  path: string,
  guard: unknown,
): boolean {
  const layer = router.stack.find(
    (l) => l.route?.path === path && l.route?.methods?.[method] === true,
  );
  if (!layer?.route) return false;
  return layer.route.stack.some((h) => h.handle === guard);
}

describe("destructive & bulk endpoints are wired to the policy guards", () => {
  it.each([
    ["assets bulk-update", assetsRouter, "post", "/assets/bulk-update", requireBulkMutation],
    ["assets bulk-delete", assetsRouter, "post", "/assets/bulk-delete", requireBulkMutation],
    ["asset delete", assetsRouter, "delete", "/assets/:id", requireDestructive],
    ["template delete", templatesRouter, "delete", "/templates/:id", requireDestructive],
    ["brand archive", brandsRouter, "delete", "/brands/:id", requireDestructive],
    ["brand logo delete", brandsRouter, "delete", "/brands/:id/logos/:assetId", requireDestructive],
    ["brand font delete", brandsRouter, "delete", "/brands/:id/fonts/:assetId", requireDestructive],
    ["social account delete", socialAccountsRouter, "delete", "/social-accounts/:id", requireDestructive],
    ["hashtag set delete", hashtagSetsRouter, "delete", "/hashtag-sets/:id", requireDestructive],
    ["content plan delete", contentPlanRouter, "delete", "/content-plan/:id", requireDestructive],
    ["calendar entry delete", calendarEntriesRouter, "delete", "/calendar-entries/:id", requireDestructive],
  ])("%s requires the elevated guard", (_label, router, method, path, guard) => {
    expect(
      routeHasGuard(router as unknown as { stack: RouteLayer[] }, method, path, guard),
    ).toBe(true);
  });
});
