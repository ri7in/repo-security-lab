import { describe, expect, it } from "vitest";
import { parseRuntimeConfiguration } from "../src/runtime-config.js";

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PRIVATE_SLICE_ACCOUNT_IDS: "123",
    GITLEAKS_BINARY: "/trusted/gitleaks",
    GITLEAKS_SHA256: "a".repeat(64),
    ...overrides,
  };
}

describe("private local runtime configuration", () => {
  it("requires immutable account ids and exact scanner identity", () => {
    const configuration = parseRuntimeConfiguration(environment(), "/product");
    expect(configuration).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      databasePath: "/product/.data/store.sqlite",
      scratchPath: "/product/.data/scratch",
      gitleaksBinary: "/trusted/gitleaks",
      operatorMode: false,
    });
    expect(configuration.allowedRequestedLogins).toEqual(new Set(["ri7in"]));
    expect(configuration.allowedGithubAccountIds).toEqual(new Set([123]));
  });

  it("refuses public binding, invalid ids, and malformed hashes", () => {
    for (const invalid of [
      environment({ HOST: "0.0.0.0" }),
      environment({ HOST: "localhost" }),
      environment({ PRIVATE_SLICE_ACCOUNT_IDS: "not-an-id" }),
      environment({ GITLEAKS_SHA256: "short" }),
    ]) {
      expect(() => parseRuntimeConfiguration(invalid)).toThrow();
    }
  });
});
