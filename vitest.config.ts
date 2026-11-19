import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    // Property tests take 0.1–1 s alone but several times longer when the
    // PGlite (WASM) suites and IDE hook runs share the CPU. 5 s was flaky.
    testTimeout: 20_000,
  },
});
