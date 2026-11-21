// Supabase Auth against local Supabase (dashboard-simulator task 1). Uses the
// local project's keys from `supabase status`; the service-role key is used
// here only to create and delete a throwaway user, as the seed would.
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function localKeys(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("supabase/package.json")), "dist", "supabase.js");
  const out = execFileSync(process.execPath, [cli, "status", "-o", "env"], { encoding: "utf8" });
  return Object.fromEntries(out.split(/\r?\n/).flatMap((l) => (/^([A-Z_]+)="?(.*?)"?$/.exec(l) ? [[RegExp.$1, RegExp.$2]] : [])));
}

const keys = localKeys();
const url = keys.API_URL as string;
const email = `it-${Date.now()}@example.com`;
const password = "integration-pass-123";
let userId = "";
const admin = createClient(url, keys.SERVICE_ROLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });

beforeAll(async () => {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) throw new Error("not local Supabase");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
});
afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId);
});

describe("integration: Supabase Auth with the publishable key (D1)", () => {
  const anon = () => createClient(url, keys.PUBLISHABLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });

  it("a leader created by the admin API signs in, and getClaims verifies the token and returns the user id", async () => {
    const c = anon();
    const { error } = await c.auth.signInWithPassword({ email, password });
    expect(error).toBeNull();
    const { data } = await c.auth.getClaims();
    expect(data?.claims.sub).toBe(userId);
  });

  it("a wrong password is refused", async () => {
    const { error } = await anon().auth.signInWithPassword({ email, password: "wrong-password-0" });
    expect(error).not.toBeNull();
  });

  it("sign-ups are disabled (D1.8)", async () => {
    const { error } = await anon().auth.signUp({ email: `new-${Date.now()}@example.com`, password });
    expect(error?.message ?? "").toMatch(/sign ?ups? (are |is )?(not allowed|disabled)/i);
  });

  it("the publishable key reads no table, signed in or not", async () => {
    const signedIn = anon();
    await signedIn.auth.signInWithPassword({ email, password });
    for (const client of [anon(), signedIn]) {
      for (const table of ["groups", "members", "member_credentials", "ledger_entries", "ussd_rate_limits"]) {
        const { data, error } = await client.from(table).select("*").limit(1);
        expect({ table, rows: data?.length ?? 0, refused: error !== null }).toEqual({ table, rows: 0, refused: true });
      }
    }
  });
});
