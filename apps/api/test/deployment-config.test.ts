import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface WranglerConfiguration {
  readonly assets?: { readonly run_worker_first?: unknown };
  readonly vars?: { readonly PUBLIC_SCANNING_ENABLED?: unknown };
}

describe("production control-plane configuration", () => {
  it("routes static assets through security headers while public scanning stays off", () => {
    // JSONC: whole-line comments only, stripped by line so a URL inside a
    // string ("https://...") is never mistaken for one.
    const configuration = JSON.parse(
      readFileSync("apps/control-plane/wrangler.jsonc", "utf8")
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n"),
    ) as WranglerConfiguration;

    expect(configuration.assets?.run_worker_first).toBe(true);
    expect(configuration.vars?.PUBLIC_SCANNING_ENABLED).toBe("false");
  });
});
