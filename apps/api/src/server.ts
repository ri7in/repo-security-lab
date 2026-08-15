import { mkdir } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { SourceBlindBroker } from "@app/broker";
import { GithubArchiveClient, GithubDiscoveryClient } from "@app/github";
import {
  GITLEAKS_BROKER_MANIFEST,
  GitleaksScanner,
} from "@app/scanners";
import { SqliteStore } from "@app/store-sqlite";
import { RepositoryWorker } from "@app/worker";
import { createApi } from "./app.js";
import { parseRuntimeConfiguration } from "./runtime-config.js";

const configuration = parseRuntimeConfiguration(process.env);
await mkdir(path.dirname(configuration.databasePath), {
  recursive: true,
  mode: 0o700,
});
const store = new SqliteStore({ filename: configuration.databasePath });
const discovery = new GithubDiscoveryClient({
  ...(configuration.githubToken === undefined
    ? {}
    : { token: configuration.githubToken }),
});
const worker = new RepositoryWorker({
  store,
  archiveFetcher: new GithubArchiveClient({
    ...(configuration.githubToken === undefined
      ? {}
      : { token: configuration.githubToken }),
  }),
  gitleaks: new GitleaksScanner({
    binaryPath: configuration.gitleaksBinary,
    expectedBinarySha256: configuration.gitleaksSha256,
  }),
  gitleaksBroker: new SourceBlindBroker(
    "gitleaks",
    GITLEAKS_BROKER_MANIFEST,
  ),
  workerId: `worker_${process.pid}`,
  scratchBase: configuration.scratchPath,
  allowedGithubAccountIds: configuration.allowedGithubAccountIds,
});
await worker.cleanStartupOrphans();

const app = createApi({
  store,
  discovery,
  allowedRequestedLogins: configuration.allowedRequestedLogins,
  allowedGithubAccountIds: configuration.allowedGithubAccountIds,
  operatorMode: configuration.operatorMode,
  bindHost: configuration.host,
  enforceHostHeader: true,
});

let workerBusy = false;
const tick = async (): Promise<void> => {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await worker.reapExpired();
    for (let index = 0; index < 10; index += 1) {
      const result = await worker.runOne();
      if (result === "idle") break;
      process.stdout.write(`${JSON.stringify({ event: "worker_result", result })}\n`);
    }
  } catch {
    process.stderr.write('{"event":"worker_tick_failed"}\n');
  } finally {
    workerBusy = false;
  }
};

const interval = setInterval(() => void tick(), 1_000);
interval.unref();
void tick();
const server = serve({
  fetch: app.fetch,
  hostname: configuration.host,
  port: configuration.port,
});
process.stdout.write(
  `${JSON.stringify({
    event: "api_started",
    host: configuration.host,
    port: configuration.port,
  })}\n`,
);

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  server.close(() => {
    const closeStoreWhenIdle = (): void => {
      if (workerBusy) {
        setTimeout(closeStoreWhenIdle, 50);
        return;
      }
      store.close();
      process.exitCode = 0;
    };
    closeStoreWhenIdle();
  });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
