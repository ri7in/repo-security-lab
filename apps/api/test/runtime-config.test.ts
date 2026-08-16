import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePrivateDatabaseParent,
  parseRuntimeConfiguration,
} from "../src/runtime-config.js";

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
  it("creates a private database parent and rejects permissive or symlinked ones", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "repo-security-config-"));
    try {
      const created = path.join(root, "created", "store.sqlite");
      await ensurePrivateDatabaseParent(created);
      expect((await lstat(path.dirname(created))).mode & 0o777).toBe(0o700);

      const permissive = path.join(root, "permissive");
      await mkdir(permissive, { mode: 0o755 });
      await chmod(permissive, 0o755);
      await expect(
        ensurePrivateDatabaseParent(path.join(permissive, "store.sqlite")),
      ).rejects.toThrow("invalid database directory");
      expect((await lstat(permissive)).mode & 0o777).toBe(0o755);

      const actual = path.join(root, "actual");
      const redirected = path.join(root, "redirected");
      await mkdir(actual, { mode: 0o700 });
      await symlink(actual, redirected);
      await expect(
        ensurePrivateDatabaseParent(path.join(redirected, "store.sqlite")),
      ).rejects.toThrow("invalid database directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      environment({ PRIVATE_SLICE_ACCOUNT_IDS: "123,0123" }),
      environment({ PRIVATE_SLICE_LOGINS: "ri7in,RI7IN" }),
      environment({ GITLEAKS_SHA256: "short" }),
      environment({
        DATABASE_PATH: "/product/.data/scratch/store.sqlite",
        SCRATCH_PATH: "/product/.data/scratch",
      }),
      environment({
        GITLEAKS_BINARY: "/product/.data/scratch/gitleaks",
        SCRATCH_PATH: "/product/.data/scratch",
      }),
    ]) {
      expect(() => parseRuntimeConfiguration(invalid)).toThrow();
    }
  });
});
