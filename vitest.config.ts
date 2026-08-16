import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    exclude: ["**/*.workers.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      // These modules execute under workerd and are covered by the mandatory
      // test:workers suite. Node's V8 inspector coverage is unavailable inside
      // the Cloudflare pool, so counting them here would report false zeroes.
      exclude: [
        "apps/control-plane/src/**/*.ts",
        "apps/scan-worker/src/server.ts",
        "packages/store-d1/src/**/*.ts",
        "packages/store-http/src/**/*.ts",
        "packages/worker-protocol/src/**/*.ts",
      ],
      thresholds: {
        statements: 74,
        branches: 72,
        functions: 76,
        lines: 76,
      },
    },
  },
});
