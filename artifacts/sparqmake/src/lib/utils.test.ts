import { describe, it, expect } from "vitest";
import { isForbidden, PERMISSION_DENIED_MESSAGE } from "./utils";

describe("isForbidden", () => {
  it("returns true for a 403 Response", () => {
    expect(isForbidden(new Response(null, { status: 403 }))).toBe(true);
  });

  it("returns false for a non-403 Response", () => {
    expect(isForbidden(new Response(null, { status: 500 }))).toBe(false);
    expect(isForbidden(new Response(null, { status: 200 }))).toBe(false);
  });

  it("returns true for a thrown error carrying status 403", () => {
    expect(isForbidden({ status: 403 })).toBe(true);
  });

  it("returns false for errors with other statuses or shapes", () => {
    expect(isForbidden({ status: 401 })).toBe(false);
    expect(isForbidden(new Error("boom"))).toBe(false);
    expect(isForbidden(null)).toBe(false);
    expect(isForbidden(undefined)).toBe(false);
  });

  it("exposes the shared permission-denied copy", () => {
    expect(PERMISSION_DENIED_MESSAGE).toBe("You don't have permission to do that");
  });
});
