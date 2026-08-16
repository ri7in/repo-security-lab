import { SourceBlindBroker } from "@app/broker";
import { GithubArchiveClient } from "@app/github";
import { GITLEAKS_BROKER_MANIFEST, GitleaksScanner } from "@app/scanners";
import { HttpWorkerStore } from "@app/store-http";
import { RepositoryWorker } from "@app/worker";
import { parseScanWorkerConfiguration } from "./runtime-config.js";

const configuration = parseScanWorkerConfiguration(process.env);
const store = new HttpWorkerStore({
  baseUrl: configuration.controlPlaneUrl,
  workerId: configuration.workerId,
  keyGeneration: configuration.keyGeneration,
  workerSecret: configuration.workerSecret,
});
const repositoryWorker = new RepositoryWorker({
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
  gitleaksBroker: new SourceBlindBroker("gitleaks", GITLEAKS_BROKER_MANIFEST),
  workerId: configuration.workerId,
  scratchBase: configuration.scratchPath,
  allowedGithubAccountIds: configuration.allowedGithubAccountIds,
});

await repositoryWorker.cleanStartupOrphans();

let busy = false;
let closing = false;
const tick = async (): Promise<void> => {
  if (busy || closing) return;
  busy = true;
  try {
    const recovery = await repositoryWorker.reapExpired();
    if (recovery.requeuedCleaned > 0 || recovery.exhaustedFinalized > 0) {
      process.stdout.write(`${JSON.stringify({ event: "worker_recovery", ...recovery })}\n`);
    }
    for (let index = 0; index < configuration.maxJobsPerTick; index += 1) {
      const result = await repositoryWorker.runOne();
      if (result === "idle") break;
      process.stdout.write(
        `${JSON.stringify({ event: "worker_result", result })}\n`,
      );
    }
  } catch {
    process.stderr.write('{"event":"worker_tick_failed"}\n');
  } finally {
    busy = false;
  }
};

const interval = setInterval(() => void tick(), configuration.pollIntervalMs);
process.stdout.write(
  `${JSON.stringify({ event: "scan_worker_started", workerId: configuration.workerId })}\n`,
);
void tick();

const close = (): void => {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  const waitForIdle = (): void => {
    if (busy) {
      setTimeout(waitForIdle, 50);
      return;
    }
    process.exitCode = 0;
  };
  waitForIdle();
};

process.once("SIGINT", close);
process.once("SIGTERM", close);
