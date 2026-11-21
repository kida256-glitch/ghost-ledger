import { defineConfig, devices } from "@playwright/test";

// `npm run test:e2e`: the DEMO.md walkthrough against `next start` and local
// Supabase (dashboard-simulator D16). Not part of the Definition of Done.
// Needs a production build, a freshly seeded local database, and the env from
// DEMO.md section 8 (scripts/e2e.ps1 sets everything up).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3123",
    ...devices["Pixel 7"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node node_modules/next/dist/bin/next start -p 3123",
    url: "http://localhost:3123/simulator",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
