import { describe, expect, it } from "vitest";
import { healthResponse } from "./handler";

const verified = { status: "verified", group: "TUBEERA", entries: 3, headSeq: 3, headHash: "a".repeat(64), dbRole: "ghost_readonly" } as const;

describe("task 30: GET /api/health response mapping (design §14.3)", () => {
  it("verified and failed are 200, with the region added", async () => {
    const logs: string[] = [];
    const deps = { region: "fra1", logError: (l: string) => logs.push(l) };
    expect(await healthResponse({ ...deps, check: async () => verified })).toEqual({ status: 200, body: { ...verified, region: "fra1" } });
    const failed = { status: "failed", group: "TUBEERA", entries: 3, failedAtSeq: 2, reason: "HASH_MISMATCH", dbRole: "ghost_readonly" } as const;
    expect(await healthResponse({ ...deps, check: async () => failed })).toEqual({ status: 200, body: { ...failed, region: "fra1" } });
    expect(logs).toEqual([]);
  });

  it("not_seeded is 404", async () => {
    const r = await healthResponse({ region: null, logError: () => {}, check: async () => ({ status: "not_seeded", group: "TUBEERA" }) });
    expect(r).toEqual({ status: 404, body: { status: "not_seeded", group: "TUBEERA", region: null } });
  });

  it("a database or env error is 503 with nothing but the status, and the log gets only the class and code", async () => {
    const logs: string[] = [];
    const err = Object.assign(new Error("password authentication failed for user ghost_readonly at postgresql://ghost_readonly:pw@host"), { code: "28P01" });
    const r = await healthResponse({ region: "fra1", logError: (l) => logs.push(l), check: () => Promise.reject(err) });
    expect(r).toEqual({ status: 503, body: { status: "error" } });
    expect(logs).toEqual(["health check failed: Error 28P01"]);
    expect(JSON.stringify(r) + logs.join("")).not.toMatch(/pw@|password/);
  });
});
