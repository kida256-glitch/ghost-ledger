import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { regions?: string[]; crons?: { path: string; schedule: string }[] };

describe("ussd task 9: vercel.json (ledger-core design §14.1, ussd-engine U16)", () => {
  it("functions stay in fra1, next to Supabase eu-central-1", () => {
    expect(config.regions).toEqual(["fra1"]);
  });

  it("a daily cron calls the read-only /api/health so the hosted Supabase project never idles for 7 days", () => {
    expect(config.crons).toEqual([{ path: "/api/health", schedule: "0 6 * * *" }]);
    // Hobby plans allow at most one run per day: minute and hour fixed, the rest "*".
    expect(config.crons?.[0]?.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });

  it("the README documents the keep-alive and when it can go", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain("## Keep-alive");
    expect(readme).toContain("29 January 2027");
  });
});
