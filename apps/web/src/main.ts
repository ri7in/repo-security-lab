import { branding } from "@app/branding";
import {
  opaqueIdSchema,
  publicFindingPageSchema,
  repositoryPageSchema,
  scanRequestAcceptedSchema,
  scanRequestSummarySchema,
  type PublicFinding,
  type RepositoryRow,
  type ScanRequestSummary,
} from "@app/contracts";
import "./style.css";

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error("required interface element missing");
  return element;
};

const form = $<HTMLFormElement>("#scan-form");
const username = $<HTMLInputElement>("#username");
const button = $<HTMLButtonElement>("#scan-button");
const statusSection = $<HTMLElement>("#status-section");
const ledgerSection = $<HTMLElement>("#ledger-section");
const findingsSection = $<HTMLElement>("#findings-section");
const liveStatus = $<HTMLElement>("#live-status");
const progressBar = $<HTMLElement>("#progress-bar");
const summaryGrid = $<HTMLElement>("#summary-grid");
const rows = $<HTMLElement>("#repository-rows");
const findingRows = $<HTMLElement>("#finding-rows");
const requestIdLabel = $<HTMLElement>("#request-id");
const botCode = $<HTMLElement>("#bot-code");

$("#product-name").textContent = branding.productDisplayName;
$("#tagline").textContent = branding.tagline;
$("#footer-name").textContent = `${branding.productDisplayName} · free and open source.`;
document.title = `${branding.productDisplayName} — public repository security`;

const themeToggle = $<HTMLButtonElement>("#theme-toggle");
themeToggle.addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset["theme"] !== "dark";
  root.dataset["theme"] = dark ? "dark" : "light";
  themeToggle.setAttribute("aria-pressed", String(dark));
});

function setScanState(state: "idle" | "scanning" | "complete" | "failed"): void {
  document.body.dataset["scanState"] = state;
  botCode.textContent = {
    idle: "IDLE_00",
    scanning: "SCAN_01",
    complete: "DONE_10",
    failed: "HOLD_11",
  }[state];
}

function stateChip(state: string, reason?: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `state-chip ${state}`;
  chip.textContent = [state, reason]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.replaceAll("_", " "))
    .join(" · ");
  return chip;
}

function terminalCount(summary: ScanRequestSummary): number {
  return ["complete", "empty", "partial", "failed", "cancelled"].reduce(
    (total, state) => total + summary.repositoryTotals[state as keyof typeof summary.repositoryTotals],
    0,
  );
}

function renderSummary(summary: ScanRequestSummary): void {
  const total = Object.values(summary.repositoryTotals).reduce(
    (sum, count) => sum + count,
    0,
  );
  const terminal = terminalCount(summary);
  const values = [
    [String(total), "repositories"],
    [String(terminal), "terminal"],
    [String(summary.repositoryTotals.complete), "fully complete"],
    [
      String(
        summary.repositoryTotals.failed +
          summary.repositoryTotals.partial +
          summary.repositoryTotals.cancelled,
      ),
      "needs attention",
    ],
  ];
  summaryGrid.replaceChildren(
    ...values.map(([value, label]) => {
      const card = document.createElement("div");
      card.className = "summary-card";
      const strong = document.createElement("strong");
      strong.textContent = value ?? "0";
      const span = document.createElement("span");
      span.textContent = label ?? "";
      card.append(strong, span);
      return card;
    }),
  );
  const percent = total === 0 ? 100 : Math.round((terminal / total) * 100);
  progressBar.style.width = `${percent}%`;
  liveStatus.textContent =
    summary.state === "failed"
      ? `Request stopped: ${summary.reason?.replaceAll("_", " ") ?? "fixed safety gate"}.`
      : summary.state === "complete"
        ? `Coverage ledger complete · ${terminal}/${total} repositories terminal.`
        : `Scanning immutable snapshots · ${terminal}/${total} repositories terminal.`;
  setScanState(summary.state === "complete" ? "complete" : summary.state === "failed" ? "failed" : "scanning");
}

function renderRepositories(repositories: readonly RepositoryRow[]): void {
  rows.replaceChildren(
    ...repositories.map((repository) => {
      const row = document.createElement("tr");
      row.dataset["active"] = String(!["complete", "empty", "partial", "failed", "cancelled"].includes(repository.state));
      const name = document.createElement("td");
      name.className = "repo-name";
      name.textContent = repository.name;
      const states: ReadonlyArray<readonly [string, string | undefined]> = [
        [repository.state, repository.reason],
        [repository.coverage.snapshot, undefined],
        [repository.coverage.archive_guard, undefined],
        [repository.coverage.gitleaks, repository.specialistReasons?.gitleaks],
        [repository.coverage.osv, repository.specialistReasons?.osv],
        [repository.coverage.zizmor, repository.specialistReasons?.zizmor],
        [repository.coverage.opengrep, repository.specialistReasons?.opengrep],
      ];
      row.append(name, ...states.map(([state, reason]) => {
        const cell = document.createElement("td");
        cell.append(stateChip(state, reason));
        return cell;
      }));
      return row;
    }),
  );
}

function renderFindings(
  findings: readonly PublicFinding[],
  repositories: readonly RepositoryRow[],
): void {
  const repositoryNames = new Map(
    repositories.map((repository) => [repository.repositoryId, repository.name]),
  );
  findingRows.replaceChildren(
    ...findings.map((finding) => {
      const row = document.createElement("tr");
      const values = [
        repositoryNames.get(finding.repository_id) ??
          `repository ${finding.repository_id}`,
        finding.engine,
        finding.rule_id,
        finding.severity,
        finding.occurrence_bucket.replaceAll("_", " "),
        finding.remediation_key.replaceAll("-", " "),
      ];
      row.append(
        ...values.map((value, index) => {
          const cell = document.createElement("td");
          cell.textContent = value;
          if (index === 0) cell.className = "repo-name";
          return cell;
        }),
      );
      return row;
    }),
  );
  findingsSection.hidden = false;
  $("#finding-count").textContent = `${findings.length} source-blind finding${findings.length === 1 ? "" : "s"}`;
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const reason =
      typeof body === "object" && body !== null && "reason" in body
        ? String(body.reason)
        : "REQUEST_FAILED";
    throw new Error(reason);
  }
  return body;
}

async function loadRepositories(requestId: string): Promise<RepositoryRow[]> {
  const repositories: RepositoryRow[] = [];
  let cursor: string | undefined;
  do {
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const page = repositoryPageSchema.parse(
      await requestJson(`/api/scan-requests/${requestId}/repositories${query}`),
    );
    repositories.push(...page.repositories);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return repositories;
}

async function loadFindings(requestId: string): Promise<PublicFinding[]> {
  const findings: PublicFinding[] = [];
  let cursor: string | undefined;
  do {
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const page = publicFindingPageSchema.parse(
      await requestJson(`/api/scan-requests/${requestId}/findings${query}`),
    );
    findings.push(...page.findings);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return findings;
}

async function poll(requestId: string): Promise<void> {
  while (true) {
    const summary = scanRequestSummarySchema.parse(
      await requestJson(`/api/scan-requests/${requestId}`),
    );
    renderSummary(summary);
    const repositories = await loadRepositories(requestId);
    renderRepositories(repositories);
    ledgerSection.hidden = false;
    try {
      renderFindings(await loadFindings(requestId), repositories);
    } catch {
      // Finding detail is a separate public-safe plane. Its failure must never
      // relabel a valid coverage request as failed.
      findingsSection.hidden = true;
      findingRows.replaceChildren();
    }
    if (summary.state === "complete" || summary.state === "failed") return;
    await new Promise((resolve) =>
      setTimeout(resolve, summary.retryAfterSeconds * 1_000),
    );
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!username.checkValidity()) {
    username.reportValidity();
    return;
  }
  button.disabled = true;
  findingsSection.hidden = true;
  findingRows.replaceChildren();
  setScanState("scanning");
  statusSection.hidden = false;
  liveStatus.textContent = "Creating a durable coverage request…";
  void (async () => {
    try {
      const accepted = scanRequestAcceptedSchema.parse(
        await requestJson("/api/scan-requests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: username.value.trim() }),
        }),
      );
      requestIdLabel.textContent = accepted.requestId;
      history.replaceState(null, "", `?request=${accepted.requestId}`);
      await poll(accepted.requestId);
    } catch (error) {
      setScanState("failed");
      liveStatus.textContent = `Request stopped: ${error instanceof Error ? error.message.replaceAll("_", " ") : "fixed safety gate"}.`;
    } finally {
      button.disabled = false;
    }
  })();
});

const existingRequest = new URLSearchParams(location.search).get("request");
if (existingRequest !== null) {
  statusSection.hidden = false;
  const parsedRequest = opaqueIdSchema.safeParse(existingRequest);
  if (!parsedRequest.success) {
    setScanState("failed");
    liveStatus.textContent = "That request is unavailable.";
  } else {
    requestIdLabel.textContent = parsedRequest.data;
    button.disabled = true;
    setScanState("scanning");
    void poll(parsedRequest.data)
      .catch(() => {
        setScanState("failed");
        liveStatus.textContent = "That request is unavailable.";
      })
      .finally(() => {
        button.disabled = false;
      });
  }
}
