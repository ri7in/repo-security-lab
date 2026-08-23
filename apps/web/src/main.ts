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
  aiCoverageLabel,
  coverageLabel,
  repositoryLabel,
  type Label,
} from "./labels.js";
import { progressModel, type Step } from "./progress.js";
import { buildPdf } from "./pdf.js";
import {
  formatLocations,
  reportDocument,
  reportFileName,
  type ReportState,
} from "./report.js";
import { summarizeVerdict } from "./verdict.js";

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
const findingTable = $<HTMLElement>("#finding-table");
const nothingFound = $<HTMLElement>("#nothing-found");
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
const botSign = $<HTMLElement>("#bot-sign");
const signFill = $<HTMLElement>("#sign-fill");
const signText = $<HTMLElement>("#sign-text");
const botLive = $<HTMLElement>("#bot-live");
const livePhase = $<HTMLElement>("#live-phase");
const livePercent = $<HTMLElement>("#live-percent");
const liveBar = $<HTMLElement>("#live-bar");
const liveDetail = $<HTMLElement>("#live-detail");
const seeResults = $<HTMLButtonElement>("#see-results");
const statusTitle = $<HTMLElement>("#status-title");
const verdict = $<HTMLElement>("#verdict");
const verdictText = $<HTMLElement>("#verdict-text");
const printReport = $<HTMLButtonElement>("#print-report");
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
$("#footer-name").textContent = `${branding.productDisplayName}. Free and open source.`;
document.title = `${branding.productDisplayName}: public repository security`;

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

let heldStep: Step | null = null;

/** Replays a one-shot animation, which needs the class off before it goes on. */
function replay(element: Element, className: string): void {
  element.classList.remove(className);
  void (element as HTMLElement).offsetWidth;
  element.classList.add(className);
  setTimeout(() => {
    element.classList.remove(className);
  }, 500);
}

/**
 * Hands a step to the agent, or takes the finished one away.
 *
 * The sign is swapped rather than relabelled in place: a caption that changes
 * silently is easy to miss, and the whole point of the panel is that a visitor
 * can tell at a glance that something moved since they last looked.
 */
function handOver(next: Step | null): void {
  if (next === heldStep) return;
  const previous =
    heldStep === null
      ? null
      : stepsList.querySelector(`[data-step="${heldStep}"]`);
  if (previous !== null) replay(previous, "dropped");
  if (next !== null) {
    const taken = stepsList.querySelector(`[data-step="${next}"]`);
    if (taken !== null) replay(taken, "taken");
    botSign.dataset["swap"] = "1";
    setTimeout(() => {
      delete botSign.dataset["swap"];
    }, 500);
  }
  heldStep = next;
}

/** Paints the agent panel from the model. */
function renderSteps(summary: ScanRequestSummary): void {
  const model = progressModel(summary);
  for (const entry of model.steps) {
    const element = stepsList.querySelector<HTMLElement>(
      `[data-step="${entry.step}"]`,
    );
    if (element === null) continue;
    element.dataset["state"] = entry.state;
    const meter = element.querySelector("i");
    if (meter !== null) meter.style.width = `${String(entry.percent)}%`;
  }

  handOver(model.active);
  signText.textContent = model.signText;
  signFill.style.width = `${String(model.signPercent)}%`;

  botLive.dataset["state"] = model.liveState;
  livePhase.textContent = model.livePhase;
  livePercent.textContent = `${String(model.livePercent)}%`;
  liveBar.style.width = `${String(model.livePercent)}%`;
  liveDetail.textContent = model.liveDetail;
  seeResults.hidden = !model.finished;
}

seeResults.addEventListener("click", () => {
  document
    .querySelector(findingsSection.hidden ? "#ledger-section" : "#findings-section")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
});

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
  // Not `title`. The browser's own tooltip waits about a second before it
  // appears, which is long enough that a visitor concludes hovering does
  // nothing and stops trying. This one is CSS and shows immediately.
  chip.dataset["detail"] = label.detail;
  chip.setAttribute("aria-label", `${label.text}. ${label.detail}`);
  chip.tabIndex = 0;
  return chip;
}

function terminalCount(summary: ScanRequestSummary): number {
  return ["complete", "empty", "partial", "failed", "cancelled"].reduce(
    (total, state) => total + summary.repositoryTotals[state as keyof typeof summary.repositoryTotals],
    0,
  );
}

let findingsShown = 0;

function renderSummary(summary: ScanRequestSummary): void {
  const total = Object.values(summary.repositoryTotals).reduce(
    (sum, count) => sum + count,
    0,
  );
  const terminal = terminalCount(summary);
  const notChecked =
    summary.repositoryTotals.failed +
    summary.repositoryTotals.partial +
    summary.repositoryTotals.cancelled;
  // "Terminal" is a word from the state machine, and a skipped fork was being
  // counted under "needs attention" as though the visitor had to do something
  // about it. Four numbers a visitor can act on, in the words they would use.
  const values = [
    [String(total), "public repositories"],
    [String(summary.repositoryTotals.complete), "fully scanned"],
    [String(notChecked), "not checked"],
    [String(findingsShown), findingsShown === 1 ? "finding" : "findings"],
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
      ? `Request stopped: ${summary.reason?.replaceAll("_", " ").toLowerCase() ?? "fixed safety gate"}.`
      : summary.state === "complete"
        ? `All ${String(total)} ${total === 1 ? "repository" : "repositories"} finished.`
        : `${String(terminal)} of ${String(total)} repositories finished so far.`;
  if (notificationStatus === "queued") {
    liveStatus.textContent += " A report email is queued.";
  } else if (notificationStatus === "rate_limited") {
    liveStatus.textContent += " The email quota is used up, so keep this link.";
  } else if (notificationStatus === "unavailable") {
    liveStatus.textContent += " Email is unavailable, so keep this link.";
  }
  liveStatus.textContent += ` Updated ${new Date(summary.updatedAt).toLocaleString()}.`;
  // "Coverage in progress" over a finished ledger is the kind of stale heading
  // that makes a visitor doubt the numbers under it.
  statusTitle.textContent =
    summary.state === "complete"
      ? "Coverage complete"
      : summary.state === "failed"
        ? "Coverage stopped"
        : "Coverage in progress";
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
        aiCoverageLabel(repository.coverage.ai),
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
  $("#finding-count").textContent =
    findings.length === 0
      ? "nothing found"
      : `${String(findings.length)} finding${findings.length === 1 ? "" : "s"}`;
  // An empty table with a header row reads as a rendering fault. Say it.
  findingTable.hidden = findings.length === 0;
  nothingFound.hidden = findings.length > 0;
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
    let loadedFindings: PublicFinding[] = [];
    if (terminal) {
      try {
        const findings = await loadFindings(requestId);
        loadedFindings = findings;
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
    latest = { summary, repositories, findings: loadedFindings };
    renderVerdict(summary, repositories, loadedFindings, terminal);
    if (terminal) {
      // Repainted once the findings are in, because the card that counts them
      // cannot be filled before they arrive.
      findingsShown = findingCount;
      renderSummary(summary);
    }
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
 * Writes the report to a file.
 *
 * This used to call `window.print()`, which opens a dialog and asks the visitor
 * to choose "Save as PDF" themselves. Clicking download and getting a print
 * preview is not what download means anywhere else on the web, so the PDF is
 * built here and handed over as a file. Printing is still one button along, for
 * anyone who wants paper or their browser's own layout.
 */
let latest: ReportState | null = null;

/**
 * Says what the scan found, in one sentence, before any table.
 *
 * Hidden until the request is terminal: a verdict on a half-finished scan is a
 * guess, and a reassuring guess is the worst kind.
 */
function renderVerdict(
  summary: ScanRequestSummary,
  repositories: readonly RepositoryRow[],
  findings: readonly PublicFinding[],
  terminal: boolean,
): void {
  if (!terminal) {
    verdict.hidden = true;
    return;
  }
  const decided = summarizeVerdict(summary.username, repositories, findings);
  verdict.hidden = false;
  verdict.dataset["tone"] = decided.tone;
  verdictText.textContent = decided.text;
}

downloadReport.addEventListener("click", () => {
  if (latest === null) return;
  const document_ = reportDocument(
    latest,
    verdictText.textContent ?? "",
    location.origin,
  );
  const blob = new Blob([buildPdf(document_)], { type: "application/pdf" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = reportFileName(latest.summary);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick rather than immediately: the download is still
  // reading the blob when the click handler returns.
  setTimeout(() => {
    URL.revokeObjectURL(href);
  }, 30_000);
});

printReport.addEventListener("click", () => {
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
