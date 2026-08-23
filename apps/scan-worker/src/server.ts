import { SourceBlindBroker } from "@app/broker";
import { GithubArchiveClient } from "@app/github";
import {
  GITLEAKS_BROKER_MANIFEST,
  GitleaksScanner,
  ZIZMOR_BROKER_MANIFEST,
} from "@app/scanners";
import { HttpWorkerStore } from "@app/store-http";
import { ChatJudge } from "@app/ai-providers";
import { RepositoryWorker } from "@app/worker";
import { parseScanWorkerConfiguration } from "./runtime-config.js";
import { BubblewrapRepositoryScanDomain } from "./bubblewrap-domain.js";
import { fileURLToPath } from "node:url";

const configuration = parseScanWorkerConfiguration(process.env);
const scanDomain =
  configuration.isolation === null
    ? null
    : new BubblewrapRepositoryScanDomain({
        ...configuration.isolation,
        gitleaksBinaryPath: configuration.gitleaksBinary,
        gitleaksConfigPath: fileURLToPath(
          new URL("../../../packages/scanners/config/gitleaks.toml", import.meta.url),
        ),
        gitleaksIgnorePath: fileURLToPath(
          new URL("../../../packages/scanners/config/gitleaks.ignore", import.meta.url),
        ),
        gitleaksSha256: configuration.gitleaksSha256,
        ...(configuration.zizmor === null
          ? {}
          : {
              zizmorBinaryPath: configuration.zizmor.binaryPath,
              zizmorSha256: configuration.zizmor.sha256,
            }),
      });
if (scanDomain !== null) await scanDomain.verify();
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
  ...(scanDomain === null
    ? {
        gitleaks: new GitleaksScanner({
          binaryPath: configuration.gitleaksBinary,
          expectedBinarySha256: configuration.gitleaksSha256,
        }),
      }
    : { scanDomain }),
  gitleaksBroker: new SourceBlindBroker("gitleaks", GITLEAKS_BROKER_MANIFEST),
  // Judges are constructed here and injected, never reached for. The worker
  // and the review logic stay network-blind; only this composition root knows
  // a provider exists.
  ...(configuration.judges.length === 0
    ? {}
    : {
        judges: configuration.judges.map(
          (judge) =>
            new ChatJudge({
              apiKey: judge.apiKey,
              model: judge.model,
              family: judge.family,
              endpoint: judge.endpoint,
              fetch: (input, init) => fetch(input, init),
            }),
        ),
      }),
  ...(configuration.zizmor === null
    ? {}
    : {
        additionalEngines: [
          {
            engine: "zizmor" as const,
            broker: new SourceBlindBroker("zizmor", ZIZMOR_BROKER_MANIFEST),
          },
        ],
      }),
  workerId: configuration.workerId,
  scratchBase: configuration.scratchPath,
  allowedGithubAccountIds: configuration.allowedGithubAccountIds,
});

await repositoryWorker.cleanStartupOrphans();

async function runBatch(): Promise<void> {
  const recovery = await repositoryWorker.reapExpired();
  if (recovery.requeuedCleaned > 0 || recovery.exhaustedFinalized > 0) {
    process.stdout.write(
      `${JSON.stringify({ event: "worker_recovery", ...recovery })}\n`,
    );
  }
  for (let index = 0; index < configuration.maxJobsPerTick; index += 1) {
    const result = await repositoryWorker.runOne();
    if (result === "idle") break;
    process.stdout.write(
      `${JSON.stringify({ event: "worker_result", result })}\n`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify({
    event: "scan_worker_started",
    workerId: configuration.workerId,
    mode: configuration.runOnce ? "one_shot" : "service",
  })}\n`,
);

if (configuration.runOnce) {
  await runBatch();
} else {
  let busy = false;
  let closing = false;
  const tick = async (): Promise<void> => {
    if (busy || closing) return;
    busy = true;
    try {
      await runBatch();
    } catch {
      process.stderr.write('{"event":"worker_tick_failed"}\n');
    } finally {
      busy = false;
    }
  };

  const interval = setInterval(() => void tick(), configuration.pollIntervalMs);
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
}
