import { branding } from "@app/branding";
import {
  opaqueIdSchema,
  publicCapabilitiesSchema,
  publicFindingPageSchema,
  repositoryPageSchema,
  scanRequestAcceptedSchema,
  scanRequestSummarySchema,
  type DeepReadBudget,
  type PublicFinding,
  type RepositoryRow,
  type ScanRequestSummary,
} from "@app/contracts";
import "./style.css";
import {
  describeWhen,
  forgetScan,
  readHistory,
  rememberScan,
  type HistoryEntry,
} from "./history.js";
import {
  aiLaneLabel,
  coverageLabel,
  repositoryLabel,
  type Label,
} from "./labels.js";

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error("required interface element missing");
  return element;
};

const form = $<HTMLFormElement>("#scan-form");
const username = $<HTMLInputElement>("#username");
const email = $<HTMLInputElement>("#email");
const emailOption = $<HTMLElement>("#email-option");
const serviceNote = $<HTMLElement>("#service-note");
const button = $<HTMLButtonElement>("#scan-button");
const statusSection = $<HTMLElement>("#status-section");
const ledgerSection = $<HTMLElement>("#ledger-section");
const findingsSection = $<HTMLElement>("#findings-section");
const liveStatus = $<HTMLElement>("#live-status");
const progressBar = $<HTMLElement>("#progress-bar");
const summaryGrid = $<HTMLElement>("#summary-grid");
const rows = $<HTMLElement>("#repository-rows");
const findingRows = $<HTMLElement>("#finding-rows");
const botCode = $<HTMLElement>("#bot-code");
const ledgerNote = $<HTMLElement>("#ledger-note");
const downloadReport = $<HTMLButtonElement>("#download-report");
const printTitle = $<HTMLElement>("#print-title");
const printMeta = $<HTMLElement>("#print-meta");
const historyPanel = $<HTMLDetailsElement>("#history");
const historyList = $<HTMLElement>("#history-list");
const historyCount = $<HTMLElement>("#history-count");
const historyClear = $<HTMLButtonElement>("#history-clear");
const stepsList = $<HTMLElement>("#steps");
const stepsNote = $<HTMLElement>("#steps-note");
const quotaMeter = $<HTMLElement>("#quota-meter");
const quotaPercent = $<HTMLElement>("#quota-percent");
const quotaBar = $<HTMLElement>("#quota-bar");
const quotaLine = $<HTMLElement>("#quota-line");
const quotaSub = $<HTMLElement>("#quota-sub");
const aiDisclosure = $<HTMLElement>("#ai-disclosure");
const aiProviderName = $<HTMLElement>("#ai-provider-name");
let emailEnabled = false;
let notificationStatus: "not_requested" | "queued" | "unavailable" | "rate_limited" = "not_requested";

$("#product-name").textContent = branding.productDisplayName;
$("#tagline").textContent = branding.tagline;
$("#footer-name").textContent = `${branding.productDisplayName} · private release preview.`;
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
    idle: "Waiting",
    scanning: "Running",
    complete: "Done",
    failed: "Stopped",
  }[state];
}

const STEP_ORDER = ["discover", "download", "scan", "review"] as const;
type Step = (typeof STEP_ORDER)[number];

/**
 * Drives the four progress steps from the real ledger.
 *
 * The panel used to be an ASCII robot with a fixed caption, so it looked alive
 * while telling a visitor nothing. Every step here is derived from counts the
 * server actually reports, and a step only turns green once that many
 * repositories have genuinely passed it.
 */
function renderSteps(summary: ScanRequestSummary): void {
  const totals = summary.repositoryTotals;
  const count = (...states: readonly string[]): number =>
    states.reduce(
      (sum, state) =>
        sum + (totals[state as keyof typeof totals] ?? 0),
      0,
    );

  const all = Object.values(totals).reduce((sum, value) => sum + value, 0);
  const terminal = count("complete", "empty", "partial", "failed", "cancelled");
  const downloaded = all - count("discovered", "waiting", "leased");
  const scanned = all - count("discovered", "waiting", "leased", "acquiring", "guarding");
  const reviewed = terminal;

  const progress: Record<Step, { done: number; total: number }> = {
    // Discovery is finished once the request has left the "accepted" and
    // "discovering" states, which is the only signal the summary carries.
    discover: {
      done: summary.state === "accepted" || summary.state === "discovering" ? 0 : all,
      total: all || 1,
    },
    download: { done: downloaded, total: all || 1 },
    scan: { done: scanned, total: all || 1 },
    review: { done: reviewed, total: all || 1 },
  };

  let activeFound = false;
  for (const step of STEP_ORDER) {
    const element = stepsList.querySelector<HTMLElement>(`[data-step="${step}"]`);
    if (element === null) continue;
    const { done, total } = progress[step];
    const complete = all > 0 && done >= total;
    // Exactly one step is "active": the first unfinished one. Marking several
    // at once is what made the old panel look like nothing was happening.
    const active = !complete && !activeFound && summary.state !== "complete";
    if (active) activeFound = true;
    element.dataset["state"] = complete ? "done" : active ? "active" : "todo";
    const meter = element.querySelector("i");
    if (meter !== null) {
      meter.style.width = `${String(all === 0 ? 0 : Math.round((done / total) * 100))}%`;
    }
  }

  stepsNote.textContent =
    summary.state === "complete"
      ? `Finished. ${String(terminal)} of ${String(all)} repositories accounted for.`
      : all === 0
        ? "Looking up the account."
        : `${String(terminal)} of ${String(all)} repositories finished.`;
}

/**
 * Renders one outcome as a chip.
 *
 * The tone class carries the colour, so "nothing to check" reads as fine and
 * only a real problem reads as a problem. The explanation goes in `title`
 * because a chip has room for two words and a visitor needs a sentence.
 */
function labelChip(label: Label): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `state-chip tone-${label.tone}`;
  chip.textContent = label.text;
  chip.title = label.detail;
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
  if (notificationStatus === "queued") {
    liveStatus.textContent += " · report email queued.";
  } else if (notificationStatus === "rate_limited") {
    liveStatus.textContent += " · email quota reached; keep this report link.";
  } else if (notificationStatus === "unavailable") {
    liveStatus.textContent += " · email unavailable; keep this report link.";
  }
  liveStatus.textContent += ` · updated ${new Date(summary.updatedAt).toLocaleString()}`;
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
      // Three columns a visitor can act on. The pipeline stages that used to
      // sit here (snapshot, guard, normalize) are internal bookkeeping, and
      // the checkers that are not switched on yet only ever said "not
      // applicable", which read as a fault rather than as nothing to do.
      const cells: readonly Label[] = [
        repositoryLabel(repository.state, repository.reason),
        coverageLabel(
          repository.coverage.gitleaks,
          repository.specialistReasons?.gitleaks,
        ),
        aiLaneLabel(repository.aiLane),
      ];
      row.append(name, ...cells.map((label) => {
        const cell = document.createElement("td");
        cell.append(labelChip(label));
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
        finding.rule_id.replaceAll("-", " "),
        finding.severity,
        finding.occurrence_bucket.replaceAll("_", " "),
        formatLocations(finding.locations),
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
  $("#finding-count").textContent = `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
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

async function loadRepositories(
  requestId: string,
  full: boolean,
): Promise<RepositoryRow[]> {
  const repositories: RepositoryRow[] = [];
  let cursor: string | undefined;
  do {
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const page = repositoryPageSchema.parse(
      await requestJson(`/api/scan-requests/${requestId}/repositories${query}`),
    );
    repositories.push(...page.repositories);
    cursor = page.nextCursor;
  } while (full && cursor !== undefined);
  ledgerNote.textContent =
    !full && cursor !== undefined
      ? "Showing the first 100 repositories while scanning. The complete ledger loads when the request finishes."
      : "";
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
  let etag: string | undefined;
  let retryAfterSeconds = 3;
  while (true) {
    const response = await fetch(`/api/scan-requests/${requestId}`, {
      headers: etag === undefined ? {} : { "if-none-match": etag },
    });
    if (response.status === 304) {
      await new Promise((resolve) =>
        setTimeout(resolve, retryAfterSeconds * 1_000),
      );
      continue;
    }
    if (!response.ok) throw new Error("REQUEST_FAILED");
    const summary = scanRequestSummarySchema.parse(await response.json());
    retryAfterSeconds = summary.retryAfterSeconds;
    etag = response.headers.get("etag") ?? undefined;
    renderSummary(summary);
    renderSteps(summary);
    const terminal = summary.state === "complete" || summary.state === "failed";
    const repositories = await loadRepositories(requestId, terminal);
    renderRepositories(repositories);
    ledgerSection.hidden = false;
    let findingCount = 0;
    if (terminal) {
      try {
        const findings = await loadFindings(requestId);
        findingCount = findings.length;
        renderFindings(findings, repositories);
      } catch {
        // Finding detail is a separate public-safe plane. Its failure must never
        // relabel a valid coverage request as failed.
        findingsSection.hidden = true;
        findingRows.replaceChildren();
      }
    }
    // Written on every poll, not only at the end, so a visitor who reloads
    // mid-scan can still find their way back to a run that is still going.
    setPrintHeader(summary, findingCount);
    renderHistory(
      rememberScan({
        requestId,
        username: summary.username,
        at: Date.now(),
        findings: findingCount,
        repositories: repositories.length,
        complete: terminal,
      }),
    );
    if (terminal) return;
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
  if (emailEnabled && email.value !== "" && !email.checkValidity()) {
    email.reportValidity();
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
          body: JSON.stringify({
            username: username.value.trim(),
            ...(emailEnabled && email.value.trim() !== ""
              ? { email: email.value.trim() }
              : {}),
          }),
        }),
      );
      notificationStatus = accepted.notification;
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

/**
 * Paints the deep-read meter.
 *
 * The number shown is the scarcest council member's remaining share of its own
 * day, because the council cannot run at all without every member. Showing an
 * average here would promise depth the tightest free tier cannot deliver.
 */
function renderDeepReadBudget(budget: DeepReadBudget): void {
  const percent = Math.max(0, Math.min(100, budget.percentRemaining));
  const level = !budget.available
    ? "empty"
    : percent <= 15
      ? "critical"
      : percent <= 50
        ? "low"
        : "healthy";

  // The disclosure appears only while the lane can actually run. A standing
  // warning about a disabled feature trains people to skip the footer.
  aiDisclosure.hidden = !budget.available;
  aiProviderName.textContent =
    budget.providers.length === 0
      ? "an external model provider"
      : budget.providers.join(" and ");

  quotaMeter.dataset["level"] = level;
  quotaPercent.textContent = `${String(percent)}%`;
  quotaBar.style.width = `${String(percent)}%`;

  // Written for someone who does not know or care what a model is. No model
  // names, no provider names, no "deep read". Just how much is left and what
  // to do when it runs out.
  if (!budget.available) {
    quotaLine.textContent =
      "Today's free compute is used up. Secret scanning still runs on every repository.";
    quotaSub.textContent =
      "This is a free side project, so there is only so much to go around each day. It resets overnight. Please come back tomorrow.";
    return;
  }

  const repos = budget.repoLimitPerRequest;
  quotaLine.textContent =
    `${String(budget.deepReadsRemaining)} of ${String(budget.deepReadsPerDay)} full code reviews left today. ` +
    `Each scan reviews your ${String(repos)} most recently updated ${repos === 1 ? "repository" : "repositories"} line by line. Every other repository still gets the secret scan.`;
  quotaSub.textContent =
    "Free and open source, run by one person. The daily budget is small on purpose and resets overnight.";
}

void requestJson("/api/capabilities")
  .then((value) => {
    const capabilities = publicCapabilitiesSchema.parse(value);
    emailEnabled = capabilities.emailNotifications;
    emailOption.hidden = !emailEnabled;
    renderDeepReadBudget(capabilities.deepRead);
    serviceNote.textContent =
      capabilities.scanCreation === "public"
        ? "No sign-up, no card, and your code is never run. Results appear as each repository finishes."
        : "Scanning is limited to the operator account right now. Existing report links still work.";
  })
  .catch(() => {
    emailOption.hidden = true;
    quotaMeter.dataset["level"] = "unknown";
    quotaPercent.textContent = "--%";
    quotaLine.textContent = "Today's model allowance is unavailable right now.";
    quotaSub.textContent = "The secret scan does not depend on it and still runs on every repository.";
  });

const existingRequest = new URLSearchParams(location.search).get("request");
if (existingRequest !== null) {
  statusSection.hidden = false;
  const parsedRequest = opaqueIdSchema.safeParse(existingRequest);
  if (!parsedRequest.success) {
    setScanState("failed");
    liveStatus.textContent = "That request is unavailable.";
  } else {
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

/**
 * Renders where a finding sits.
 *
 * Always set with textContent by the caller, never innerHTML: a path comes
 * from the scanned repository, so it is attacker-controlled text and must
 * never be parsed as markup. Findings with no location render as a dash
 * rather than an empty cell, so "we did not locate this" stays distinct from
 * "this has no location".
 */
function formatLocations(
  locations: readonly { path: string; startLine: number }[] | undefined,
): string {
  if (locations === undefined || locations.length === 0) return "not located";
  const shown = locations
    .slice(0, 3)
    .map((entry) => `${entry.path}:${String(entry.startLine)}`)
    .join(", ");
  return locations.length > 3
    ? `${shown} and ${String(locations.length - 3)} more`
    : shown;
}

/**
 * Draws the past-scan list.
 *
 * Entries open the report they point at rather than re-running it: a visitor
 * coming back after a week usually wants to read what they already have, and a
 * re-run costs shared daily compute.
 */
function renderHistory(entries: readonly HistoryEntry[]): void {
  historyPanel.hidden = entries.length === 0;
  historyCount.textContent =
    entries.length === 0 ? "" : String(entries.length);
  const now = Date.now();
  historyList.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";

      const who = document.createElement("span");
      who.className = "who";
      who.textContent = entry.username;

      const when = document.createElement("span");
      when.className = "when";
      when.textContent = describeWhen(entry.at, now);

      const what = document.createElement("span");
      what.className = entry.findings > 0 ? "what hit" : "what";
      what.textContent = entry.complete
        ? `${String(entry.repositories)} repos · ${
            entry.findings === 0
              ? "nothing found"
              : `${String(entry.findings)} finding${entry.findings === 1 ? "" : "s"}`
          }`
        : "still running";

      button.append(who, when, what);
      button.addEventListener("click", () => {
        window.location.search = `?request=${entry.requestId}`;
      });
      item.append(button);
      return item;
    }),
  );
}

historyClear.addEventListener("click", () => {
  for (const entry of readHistory()) forgetScan(entry.requestId);
  renderHistory(readHistory());
});

renderHistory(readHistory());

/**
 * Prepares the printable version and hands it to the browser.
 *
 * The browser's own print pipeline is the PDF generator. It costs nothing, adds
 * no dependency, and produces real selectable text, which a canvas screenshot
 * library would not. The visitor picks "Save as PDF" in the dialog.
 */
downloadReport.addEventListener("click", () => {
  window.print();
});

function setPrintHeader(summary: ScanRequestSummary, findings: number): void {
  printTitle.textContent = `Security report for ${summary.username}`;
  const counted = Object.values(summary.repositoryTotals).reduce(
    (sum, value) => sum + value,
    0,
  );
  printMeta.textContent =
    `${String(counted)} public ${counted === 1 ? "repository" : "repositories"} examined · ` +
    `${findings === 0 ? "nothing found" : `${String(findings)} finding${findings === 1 ? "" : "s"}`} · ` +
    `scanned ${new Date(summary.updatedAt).toLocaleString()} · ` +
    `${branding.productDisplayName}`;
}
