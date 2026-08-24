import { SourceBlindBroker } from "@app/broker";
import { GithubArchiveClient } from "@app/github";
import {
  GITLEAKS_BROKER_MANIFEST,
  GitleaksScanner,
  ZIZMOR_BROKER_MANIFEST,
} from "@app/scanners";
import { HttpWorkerStore } from "@app/store-http";
import { branding } from "@app/branding";
import { FallbackScout } from "@app/ai";
import { ChatJudge, OpenRouterScout } from "@app/ai-providers";
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
  // The reader. Its data policy is set from the site's published disclosure
  // rather than an account default, so the routing decision is visible here
  // instead of in a dashboard someone can change.
  ...(configuration.scout === null
    ? {}
    : {
        scout: new FallbackScout(
          configuration.scout.models.map(
            (model) =>
              new OpenRouterScout({
                apiKey: configuration.scout?.apiKey ?? "",
                model,
                fetch: (input, init) => fetch(input, init),
                dataPolicy: { allowTrainingProviders: true },
                appTitle: branding.productDisplayName,
              }),
          ),
          (index) => {
            // Says which reader failed, so a chain quietly running on its last
            // link does not look identical to one running on its first.
            process.stderr.write(
              `${JSON.stringify({
                event: "scout_fallback",
                failed: configuration.scout?.models[index] ?? "unknown",
              })}\n`,
            );
          },
        ),
      }),
  // Judges are constructed here and injected, never reached for. The worker
  // and the review logic stay network-blind; only this composition root knows
  // a provider exists.
  //
  // Two panels from one configuration. The council judging the deterministic
  // scanners' findings takes every judge in the configuration's trust order.
  // The funnel judging the SCOUT's findings must exclude the scout's own
  // family, because a model voting on its own report is one opinion wearing
  // two hats, which is the failure the council exists to prevent.
  ...(configuration.judges.length === 0
    ? {}
    : {
        judges: configuration.judges
          .filter((judge) => judge.family !== "openrouter")
          .map(
            (judge) =>
              new ChatJudge({
                apiKey: judge.apiKey,
                model: judge.model,
                family: judge.family,
                endpoint: judge.endpoint,
                fetch: (input, init) => fetch(input, init),
              }),
          ),
        councilJudges: configuration.judges.map(
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
