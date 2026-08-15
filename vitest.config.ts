import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 75,
        lines: 70,
      },
    },
  },
});
