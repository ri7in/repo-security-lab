import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const appRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(appRoot, "migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    include: ["apps/control-plane/test/**/*.workers.test.ts"],
    setupFiles: ["./apps/control-plane/test/apply-migrations.ts"],
  },
});
