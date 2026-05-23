import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/__tests__/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["**/dist/**", "**/__tests__/**", "**/*.config.*"],
    },
  },
});
