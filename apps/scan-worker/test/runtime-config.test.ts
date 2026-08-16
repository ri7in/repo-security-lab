import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseScanWorkerConfiguration } from "../src/runtime-config.js";

function environment(): NodeJS.ProcessEnv {
  return {
    CONTROL_PLANE_URL: "https://control.example",
    WORKER_ID: "worker_runtime001",
    WORKER_KEY_GENERATION: "1",
    WORKER_SECRET: "x".repeat(43),
    GITLEAKS_BINARY: "/opt/tools/gitleaks",
    GITLEAKS_SHA256: "a".repeat(64),
    PRIVATE_SLICE_ACCOUNT_IDS: "123",
  };
}

describe("scan worker configuration", () => {
  it("defaults to a closed private scope", () => {
    const parsed = parseScanWorkerConfiguration(environment(), "/srv/worker");
    expect(parsed.allowedGithubAccountIds).toEqual(new Set([123]));
    expect(parsed.scratchPath).toBe(
      path.join("/srv/worker", ".data", "worker-scratch"),
    );
    expect(parsed.workerSecret).toHaveLength(43);
  });

  it("requires an explicit switch for the isolated public worker", () => {
    const input = environment();
    input["PUBLIC_WORKER"] = "true";
    delete input["PRIVATE_SLICE_ACCOUNT_IDS"];
    expect(
      parseScanWorkerConfiguration(input).allowedGithubAccountIds,
    ).toBeNull();
  });

  it("rejects missing secrets, roots, and malformed identities", () => {
    for (const mutation of [
      (input: NodeJS.ProcessEnv) => delete input["WORKER_SECRET"],
      (input: NodeJS.ProcessEnv) => {
        input["WORKER_ID"] = "bad id";
        return true;
      },
      (input: NodeJS.ProcessEnv) => {
        input["SCRATCH_PATH"] = "/";
        return true;
      },
    ]) {
      const input = environment();
      mutation(input);
      expect(() => parseScanWorkerConfiguration(input)).toThrow();
    }
  });
});
