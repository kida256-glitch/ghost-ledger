import { defineConfig } from "vitest/config";

// Multi-connection DB tests against local Supabase (testing.md). Not part of
// the Definition of Done. Task 25 adds the first test and global setup.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
