/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:workers" {
  export const env: {
    DB: import("@app/store-d1").D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  };
}
