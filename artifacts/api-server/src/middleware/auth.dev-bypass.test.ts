import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The production-guard behavior under test lives entirely in auth.ts; the
// logger is mocked to count warnings and @workspace/db is mocked so loading
// the module never touches a database.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock("../lib/logger", () => ({
  logger: { warn: warnSpy, info: vi.fn(), error: vi.fn() },
}));

vi.mock("@workspace/db", () => ({ db: {}, usersTable: {} }));

const ENV_KEYS = ["DEV_AUTH_BYPASS", "REPLIT_DEPLOYMENT", "NODE_ENV"] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Load a fresh copy of auth.ts so module-level state (the warn-once latch and
 * the import-time startup check) starts clean for each scenario.
 */
async function loadAuth() {
  vi.resetModules();
  return await import("./auth.js");
}

const DEPLOY_WARNING_MATCH = /deployed environment/i;

function deployWarningCount(): number {
  return warnSpy.mock.calls.filter((call) =>
    call.some((arg: unknown) => typeof arg === "string" && DEPLOY_WARNING_MATCH.test(arg)),
  ).length;
}

beforeEach(() => {
  warnSpy.mockClear();
});

afterAll(() => {
  setEnv(originalEnv as Record<(typeof ENV_KEYS)[number], string>);
});

describe("isDevBypass production guard", () => {
  it("refuses the bypass when REPLIT_DEPLOYMENT is set, even with DEV_AUTH_BYPASS=true", async () => {
    setEnv({ DEV_AUTH_BYPASS: "true", REPLIT_DEPLOYMENT: "1", NODE_ENV: "development" });
    const { isDevBypass } = await loadAuth();
    expect(isDevBypass()).toBe(false);
  });

  it("refuses the bypass when NODE_ENV=production, even with DEV_AUTH_BYPASS=true", async () => {
    setEnv({ DEV_AUTH_BYPASS: "true", REPLIT_DEPLOYMENT: undefined, NODE_ENV: "production" });
    const { isDevBypass } = await loadAuth();
    expect(isDevBypass()).toBe(false);
  });

  it("refuses the bypass when both deployment signals are present", async () => {
    setEnv({ DEV_AUTH_BYPASS: "true", REPLIT_DEPLOYMENT: "1", NODE_ENV: "production" });
    const { isDevBypass } = await loadAuth();
    expect(isDevBypass()).toBe(false);
  });

  it("honors the bypass only in a clean development environment", async () => {
    setEnv({ DEV_AUTH_BYPASS: "true", REPLIT_DEPLOYMENT: undefined, NODE_ENV: "development" });
    const { isDevBypass } = await loadAuth();
    expect(isDevBypass()).toBe(true);
  });

  it("honors the bypass when NODE_ENV is unset and no deployment signal exists", async () => {
    setEnv({ DEV_AUTH_BYPASS: "true", REPLIT_DEPLOYMENT: undefined, NODE_ENV: undefined });
    const { isDevBypass } = await loadAuth();
    expect(isDevBypass()).toBe(true);
  });

  it("returns false when the flag is not set at all, regardless of environment", async () => {
    setEnv({ DEV_AUTH_BYPASS: undefined, REPLIT_DEPLOYMENT: undefined, NODE_ENV: "development" });
    const { isDevBypass } = await loadAuth();
    expect(isDevBypass()).toBe(false);
  });

  it("returns false when the flag has a non-'true' value", async () => {
    setEnv({ DEV_AUTH_BYPASS: "1", REPLIT_DEPLOYMENT: undefined, NODE_ENV: "development" });
    const { isDevBypass } = await loadAuth();
    expect(isDevBypass()).toBe(false);
  });
});

describe("deployed-environment warning", () => {
  it("warns at most once even when isDevBypass() is called repeatedly", async () => {
    setEnv({ DEV_AUTH_BYPASS: "true", REPLIT_DEPLOYMENT: "1", NODE_ENV: "production" });
    const { isDevBypass } = await loadAuth();

    for (let i = 0; i < 25; i++) {
      expect(isDevBypass()).toBe(false);
    }

    expect(deployWarningCount()).toBe(1);
  });

  it("does not emit the deployed-environment warning in a clean dev environment", async () => {
    setEnv({ DEV_AUTH_BYPASS: "true", REPLIT_DEPLOYMENT: undefined, NODE_ENV: "development" });
    const { isDevBypass } = await loadAuth();

    isDevBypass();
    isDevBypass();

    expect(deployWarningCount()).toBe(0);
  });

  it("does not warn when the bypass flag is absent in a deployed environment", async () => {
    setEnv({ DEV_AUTH_BYPASS: undefined, REPLIT_DEPLOYMENT: "1", NODE_ENV: "production" });
    const { isDevBypass } = await loadAuth();

    isDevBypass();
    isDevBypass();

    expect(deployWarningCount()).toBe(0);
  });
});
