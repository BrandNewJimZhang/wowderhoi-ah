// Boundary test for the auto-refresh endpoint: the page poll needs one
// opaque revision for the current market, and a response that must never be
// cached, or every tab would keep reading the revision it saw first.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/market-scope", () => ({
  getMarketScope: async () => ({ id: "m1" })
}));

vi.mock("@/lib/repositories", () => ({
  getMarketRevision: async (scope: { id: string } | null) => scope ? `${scope.id}:run-1` : "none"
}));

describe("GET /api/market/revision", () => {
  it("returns the current scope's revision with no-store caching", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ revision: "m1:run-1" });
  });
});
