import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test port unavailable");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

it("composes private directory creation, exclusive store startup, and shutdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-server-"));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, "private-data", "store.sqlite");
  const scratchPath = path.join(root, "private-scratch");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/src/server.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(await availablePort()),
        DATABASE_PATH: databasePath,
        SCRATCH_PATH: scratchPath,
        PRIVATE_SLICE_ACCOUNT_IDS: "123",
        PRIVATE_SLICE_LOGINS: "ri7in",
        GITLEAKS_BINARY: process.execPath,
        GITLEAKS_SHA256: "a".repeat(64),
        GITHUB_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  const diagnostics: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`server startup timed out: ${diagnostics.join("")}`)),
      8_000,
    );
    const finish = (action: () => void): void => {
      clearTimeout(timeout);
      action();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      diagnostics.push(text);
      if (diagnostics.join("").includes('"event":"api_started"')) {
        finish(resolve);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString("utf8")));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (code !== null) {
        finish(() => reject(new Error(`server exited ${code}: ${diagnostics.join("")}`)));
      }
    });
  });

  expect((await lstat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
  expect((await lstat(databasePath)).isFile()).toBe(true);
  expect((await lstat(scratchPath)).mode & 0o777).toBe(0o700);
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`server shutdown failed: ${code}`)),
    );
  });
}, 15_000);
