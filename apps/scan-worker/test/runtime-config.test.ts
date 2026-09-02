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
    expect(parsed.runOnce).toBe(false);
    expect(parsed.isolation).toBeNull();
    expect(parsed.zizmor).toBeNull();
  });

  it("supports a bounded one-shot process for hosted CI compute", () => {
    const input = environment();
    input["RUN_ONCE"] = "true";
    input["MAX_JOBS_PER_TICK"] = "50";
    const parsed = parseScanWorkerConfiguration(input);
    expect(parsed.runOnce).toBe(true);
    expect(parsed.maxJobsPerTick).toBe(50);
  });

  it("requires an explicit switch for the isolated public worker", () => {
    const input = environment();
    input["PUBLIC_WORKER"] = "true";
    delete input["PRIVATE_SLICE_ACCOUNT_IDS"];
    expect(() => parseScanWorkerConfiguration(input)).toThrow(
      "public worker requires bubblewrap isolation",
    );
    input["SCAN_ISOLATION_MODE"] = "bubblewrap";
    input["BUBBLEWRAP_BINARY"] = "/usr/bin/bwrap";
    input["SCAN_DOMAIN_BUNDLE"] = "/opt/app/scan-domain.mjs";
    input["SCAN_RUNTIME_LIBRARY_PATHS"] =
      "/lib/aarch64-linux-gnu,/usr/lib/aarch64-linux-gnu";
    const parsed = parseScanWorkerConfiguration(input);
    expect(parsed.allowedGithubAccountIds).toBeNull();
    expect(parsed.isolation).toMatchObject({
      bubblewrapPath: "/usr/bin/bwrap",
      applicationBundlePath: "/opt/app/scan-domain.mjs",
    });
    input["ZIZMOR_ENABLED"] = "true";
    input["ZIZMOR_BINARY"] = "/opt/tools/zizmor";
    input["ZIZMOR_SHA256"] = "b".repeat(64);
    expect(parseScanWorkerConfiguration(input).zizmor).toEqual({
      binaryPath: "/opt/tools/zizmor",
      sha256: "b".repeat(64),
    });
  });

  it("keeps the zizmor lane all-or-none and isolation-only", () => {
    const disabled = environment();
    disabled["ZIZMOR_BINARY"] = "/opt/tools/zizmor";
    expect(() => parseScanWorkerConfiguration(disabled)).toThrow(
      "disabled zizmor configuration is invalid",
    );
    const inline = environment();
    inline["ZIZMOR_ENABLED"] = "true";
    inline["ZIZMOR_BINARY"] = "/opt/tools/zizmor";
    inline["ZIZMOR_SHA256"] = "b".repeat(64);
    expect(() => parseScanWorkerConfiguration(inline)).toThrow(
      "zizmor requires bubblewrap isolation",
    );
  });

  it("orders the judge panel by trust, strongest first", () => {
    // The council decides each finding by the two most senior judges that
    // answer, so this order is policy: Gemini, then gpt-oss, then Qwen. The
    // OpenRouter preview judge (stealth/ox-alpha) was removed upstream and
    // dropped, so the reader's OpenRouter key no longer adds a judge.
    const input = environment();
    input["OPENROUTER_API_KEY"] = "or-key";
    input["GEMINI_API_KEY"] = "gm-key";
    input["GROQ_API_KEY"] = "gq-key";
    const parsed = parseScanWorkerConfiguration(input);
    expect(parsed.judges.map((judge) => judge.family)).toEqual([
      "google",
      "groq",
      "qwen",
    ]);
    expect(parsed.judges[0]?.model).toBe("gemini-flash-lite-latest");
    // The only free Qwen API today, last in trust: it is a 27B preview on a
    // shared Groq quota, so it adds depth without ever outranking a senior.
    expect(parsed.judges[2]?.model).toBe("qwen/qwen3.6-27b");
  });

  it("still forms the stable pair when the preview model's key is absent", () => {
    const input = environment();
    input["GEMINI_API_KEY"] = "gm-key";
    input["GROQ_API_KEY"] = "gq-key";
    const parsed = parseScanWorkerConfiguration(input);
    expect(parsed.judges.map((judge) => judge.family)).toEqual([
      "google",
      "groq",
      "qwen",
    ]);
  });

  it("accepts a comma-separated pool of OpenRouter keys, canonical first", () => {
    // Contributed accounts, each with its own daily meter, on operator
    // instruction. The first key is canonical; the rest rotate in on a rate
    // limit. Judges on the same variable share the pool.
    const input = environment();
    input["OPENROUTER_API_KEY"] = " key-one , key-two ,key-three ";
    input["GEMINI_API_KEY"] = "gm";
    input["GROQ_API_KEY"] = "gq";
    const parsed = parseScanWorkerConfiguration(input);
    expect(parsed.scout?.apiKey).toBe("key-one");
    expect(parsed.scout?.apiKeys).toEqual(["key-one", "key-two", "key-three"]);
    // The OpenRouter pool feeds the reader; the council runs on other
    // providers, so a Gemini judge carries only its own single key.
    expect(parsed.judges[0]?.family).toBe("google");
    expect(parsed.judges[0]?.apiKeys).toEqual(["gm"]);
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
