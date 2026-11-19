import { defineConfig } from "vitest/config";

// Multi-connection DB tests against local Supabase (testing.md). Not part of
// the Definition of Done. Needs: npx supabase start && npx supabase db reset.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    globalSetup: ["src/db/testing/integration-setup.ts"],
    testTimeout: 60_000,
  },
});
