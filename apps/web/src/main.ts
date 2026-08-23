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
  formatCount,
  formatLocations,
  reportDocument,
  reportFileName,
  type ReportState,
} from "./report.js";
import { remediationLabel } from "./remediation.js";
import { initialTheme, readStoredTheme, storeTheme } from "./theme.js";
import {
  explainFailure,
  providerNames,
  percentDone,
  statusHeading,
  statusLine,
  summaryCards,
} from "./summary.js";
import { retryPlan } from "./polling.js";
import { installTooltips } from "./tooltip.js";
import { usernameProblem } from "./username.js";
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
const ledgerTable = $<HTMLElement>("#ledger-table");
const ledgerColumns = $<HTMLElement>("#ledger-columns");
const noRepositories = $<HTMLElement>("#no-repositories");
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

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function applyTheme(dark: boolean, attribute: "light" | "dark" | null): void {
  const root = document.documentElement;
  if (attribute === null) {
    delete root.dataset["theme"];
  } else {
    root.dataset["theme"] = attribute;
  }
  themeToggle.setAttribute("aria-pressed", String(dark));
  themeToggle.setAttribute(
    "aria-label",
    dark ? "Switch to the light theme" : "Switch to the dark theme",
  );
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
let themeChosen = readStoredTheme(safeStorage());
{
  const opening = initialTheme(themeChosen, systemDark.matches);
  applyTheme(opening.dark, opening.attribute);
}
// Follows the system while the visitor has not chosen for themselves.
systemDark.addEventListener("change", (event) => {
  if (themeChosen !== null) return;
  applyTheme(event.matches, null);
});

themeToggle.addEventListener("click", () => {
  const chosen = document.documentElement.dataset["theme"];
  const showingDark =
    chosen === "dark" || (chosen === undefined && systemDark.matches);
  themeChosen = showingDark ? "light" : "dark";
  storeTheme(safeStorage(), themeChosen);
  applyTheme(!showingDark, themeChosen);
});

const usernameHelp = $<HTMLElement>("#username-help");
const announcer = $<HTMLElement>("#announce");

let lastAnnounced = "";

/**
 * Says something once, when it changes.
 *
 * The page used to hold three live regions rewriting near-identical text on
 * every three-second poll, timestamp included, which is about forty
 * announcements on a twenty-three repository scan. This one speaks when the
 * step changes and when the scan ends, so roughly five times.
 */
function announce(message: string): void {
  if (message === lastAnnounced) return;
  lastAnnounced = message;
  announcer.textContent = message;
}

/** Busy without removing the button from the tab order. */
function setButtonBusy(busy: boolean): void {
  button.setAttribute("aria-disabled", String(busy));
  button.classList.toggle("is-busy", busy);
}

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

  announce(
    model.finished
      ? `${model.livePhase}. ${model.liveDetail}`
      : `${model.livePhase}, ${String(model.livePercent)} percent.`,
  );
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
    ?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
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
  const text = document.createElement("span");
  text.textContent = label.text;
  chip.append(text, explanation(label.detail));
  // Not `title`. The browser's own tooltip waits about a second before it
  // appears, which is long enough that a visitor concludes hovering does
  // nothing and stops trying.
  chip.dataset["detail"] = label.detail;
  return chip;
}

/**
 * The explanation, in the page rather than only in a tooltip.
 *
 * The chips used to be focusable spans carrying an `aria-label`, which put 69
 * dead tab stops on a 23-repository report, each one revealing a tooltip that
 * the table then clipped. As part of the cell's own text this is read in
 * order, in table context, and costs nobody a keystroke.
 */
function explanation(detail: string): HTMLElement {
  const hidden = document.createElement("span");
  hidden.className = "reader-only";
  hidden.textContent = ` ${detail}`;
  return hidden;
}

// Counted from the rows and the findings page, both of which arrive after
// the summary does, so the cards are repainted once they are in.
let findingsShown = 0;
let reviewedShown = 0;

function renderSummary(summary: ScanRequestSummary): void {
  summaryGrid.replaceChildren(
    ...summaryCards(summary, reviewedShown, findingsShown).map((entry) => {
      const card = document.createElement("div");
      card.className = "summary-card";
      const strong = document.createElement("strong");
      strong.textContent = String(entry.value);
      const span = document.createElement("span");
      span.textContent = entry.label;
      card.append(strong, span);
      return card;
    }),
  );
  progressBar.style.width = `${String(percentDone(summary))}%`;
  liveStatus.textContent = statusLine(summary);
  if (notificationStatus === "queued") {
    liveStatus.textContent += " A report email is queued.";
  } else if (notificationStatus === "rate_limited") {
    liveStatus.textContent += " The email quota is used up, so keep this link.";
  } else if (notificationStatus === "unavailable") {
    liveStatus.textContent += " Email is unavailable, so keep this link.";
  }
  liveStatus.textContent += ` Updated ${new Date(summary.updatedAt).toLocaleString()}.`;
  statusTitle.textContent = statusHeading(summary);
  setScanState(
    summary.state === "complete"
      ? "complete"
      : summary.state === "failed"
        ? "failed"
        : "scanning",
  );
}

function renderRepositories(repositories: readonly RepositoryRow[]): void {
  // Counted from the rows rather than from the request's coverage totals: the
  // stored totals predate the AI engine and never move for it.
  reviewedShown = repositories.filter(
    (repository) => repository.coverage.ai === "complete",
  ).length;
  rows.replaceChildren(
    ...repositories.map((repository) => {
      const row = document.createElement("tr");
      row.dataset["active"] = String(!["complete", "empty", "partial", "failed", "cancelled"].includes(repository.state));
      // A row header rather than a cell: navigating the ledger cell by cell
      // otherwise never re-announces which repository you are in.
      const name = document.createElement("th");
      name.scope = "row";
      name.className = "repo-name";
      const label = document.createElement("span");
      label.textContent = repository.name;
      name.append(label);
      // The one value that identifies the row, so it must stay recoverable
      // even where the column runs out of width.
      name.title = repository.name;
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
      const headings = ["Status", "Secret scan", "AI code review"];
      row.append(
        name,
        ...cells.map((label, index) => {
          const cell = document.createElement("td");
          // Read out by the stacked layout on a phone, where there is no
          // header row left to tell you which column this is.
          cell.dataset["label"] = headings[index] ?? "";
          cell.append(labelChip(label));
          return cell;
        }),
      );
      return row;
    }),
  );
}

function renderFindings(
  findings: readonly PublicFinding[],
  repositories: readonly RepositoryRow[],
  stopped: boolean,
): void {
  const repositoryNames = new Map(
    repositories.map((repository) => [repository.repositoryId, repository.name]),
  );
  findingRows.replaceChildren(
    ...findings.map((finding) => {
      const row = document.createElement("tr");
      const advice = remediationLabel(finding.remediation_key);
      const values = [
        repositoryNames.get(finding.repository_id) ??
          `repository ${String(finding.repository_id)}`,
        finding.rule_id.replaceAll("-", " "),
        finding.severity,
        formatCount(finding.occurrence_bucket),
        formatLocations(finding.locations),
      ];
      const headings = [
        "Repository",
        "What was found",
        "Severity",
        "How many",
        "Location",
      ];
      row.append(
        ...values.map((value, index) => {
          const cell = document.createElement("td");
          cell.dataset["label"] = headings[index] ?? "";
          if (index === 0) {
            // Same truncation contract as the ledger: the ellipsis needs an
            // element of its own to act on, and the full name stays on the
            // cell so it is still recoverable.
            cell.className = "repo-name";
            cell.title = value;
            const label = document.createElement("span");
            label.textContent = value;
            cell.append(label);
            return cell;
          }
          cell.textContent = value;
          return cell;
        }),
      );
      // The last column answers "what do I do now", and two words was not an
      // answer. The cell keeps a short imperative and carries the whole thing
      // on hover, the same way a state chip does.
      const todo = document.createElement("td");
      const action = document.createElement("span");
      action.className = "advice";
      action.dataset["detail"] = advice.detail;
      const short = document.createElement("span");
      short.textContent = advice.short;
      action.append(short, explanation(advice.detail));
      todo.dataset["label"] = "What to do";
      todo.append(action);
      row.append(todo);
      return row;
    }),
  );
  // A stopped scan has nothing to report either way, and offering it a
  // findings section at all invites the reader to conclude it came back clean.
  findingsSection.hidden = stopped;
  if (stopped) return;
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
  let consecutiveFailures = 0;
  let everSucceeded = false;
  while (true) {
    let summary;
    try {
      const response = await fetch(`/api/scan-requests/${requestId}`, {
        headers: etag === undefined ? {} : { "if-none-match": etag },
      });
      if (response.status === 304) {
        consecutiveFailures = 0;
        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1_000),
        );
        continue;
      }
      // A report that is genuinely gone is a different thing from a service
      // that hiccuped, and only one of them should say "not found".
      if (response.status === 404 || response.status === 410) {
        throw new Error("REQUEST_GONE");
      }
      if (!response.ok) throw new Error("REQUEST_FAILED");
      summary = scanRequestSummarySchema.parse(await response.json());
      etag = response.headers.get("etag") ?? undefined;
      consecutiveFailures = 0;
      everSucceeded = true;
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_GONE") throw error;
      consecutiveFailures += 1;
      const plan = retryPlan(
        consecutiveFailures,
        everSucceeded,
        retryAfterSeconds,
      );
      if (plan.giveUp) throw error;
      liveStatus.textContent = plan.message;
      await new Promise((resolve) => setTimeout(resolve, plan.waitMs));
      continue;
    }
    retryAfterSeconds = summary.retryAfterSeconds;
    renderSteps(summary);
    const terminal = summary.state === "complete" || summary.state === "failed";
    const repositories = await loadRepositories(requestId, terminal);
    // Before the cards, because one of them counts reviewed repositories and
    // that count is derived here. Drawing first left it a poll behind.
    renderRepositories(repositories);
    renderSummary(summary);
    ledgerSection.hidden = false;
    // A header row over nothing reads as something failing to load. The
    // findings section already says so; the ledger said nothing at all.
    const nothingListed = repositories.length === 0 && terminal;
    ledgerTable.hidden = nothingListed;
    ledgerColumns.hidden = nothingListed;
    noRepositories.hidden = !nothingListed;
    let findingCount = 0;
    let loadedFindings: PublicFinding[] = [];
    if (terminal) {
      try {
        const findings = await loadFindings(requestId);
        loadedFindings = findings;
        findingCount = findings.length;
        renderFindings(findings, repositories, summary.state === "failed");
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
        // A stopped scan used to be written as "5 repos, nothing found", which
        // is what a clean scan says, and contradicted the report it links to.
        stopped: summary.state === "failed",
      }),
    );
    if (terminal) return;
    await new Promise((resolve) =>
      setTimeout(resolve, summary.retryAfterSeconds * 1_000),
    );
  }
}

/**
 * Says what is wrong and leaves it on the page.
 *
 * `reportValidity()` alone showed "Please match the format requested." over a
 * field whose pattern was described nowhere, in a bubble that disappears.
 */
function showUsernameProblem(problem: string): void {
  usernameHelp.textContent = problem;
  username.setAttribute("aria-invalid", "true");
  username.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (button.getAttribute("aria-disabled") === "true") return;
  const problem = usernameProblem(username.value);
  if (problem !== null) {
    showUsernameProblem(problem);
    return;
  }
  usernameHelp.textContent = "";
  username.removeAttribute("aria-invalid");
  if (emailEnabled && email.value !== "" && !email.checkValidity()) {
    email.reportValidity();
    return;
  }
  // Not `disabled`. Disabling the element that holds focus takes it out of the
  // tab order and drops focus at the document root, so a keyboard user who
  // starts a scan is silently returned to the top of the page.
  setButtonBusy(true);
  findingsSection.hidden = true;
  findingRows.replaceChildren();
  setScanState("scanning");
  // Otherwise the previous account's numbers sit in the cards for the whole of
  // this scan, attributed to this account.
  findingsShown = 0;
  reviewedShown = 0;
  statusSection.hidden = false;
  liveStatus.textContent = "Looking up the account on GitHub.";
  verdict.hidden = true;
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
      liveStatus.textContent = `Scan stopped. ${explainFailure(error instanceof Error ? error.message : undefined)}`;
    } finally {
      setButtonBusy(false);
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
  aiProviderName.textContent = providerNames(budget.providers);

  quotaMeter.dataset["level"] = level;
  // The number, not a percentage of it. Nothing records what a scan spends, so
  // the percentage was always 100 and the bar was always full: a gauge that
  // cannot move is a worse lie than no gauge.
  quotaPercent.textContent = String(budget.deepReadsPerDay);
  quotaBar.style.width = `${String(percent)}%`;

  // Written for someone who does not know or care what a model is. No model
  // names, no provider names, no "deep read". Just how much is left and what
  // to do when it runs out.
  if (!budget.available) {
    quotaLine.textContent =
      "Today's free compute is used up. The secret scan still runs on every repository that is not a fork.";
    quotaSub.textContent =
      "This is a free side project, so there is only so much to go around each day. It resets overnight. Please come back tomorrow.";
    return;
  }

  const repos = budget.repoLimitPerRequest;
  // A ceiling, not a reading. Nothing records what a scan spends, so the
  // remaining figure never moves, and presenting a constant as a live gauge is
  // worse than presenting it as the limit it actually is.
  //
  // Not "your most recently updated" either: repositories are claimed in id
  // order, so that claim was falsifiable from the ledger on the same page.
  quotaLine.textContent =
    `Up to ${String(budget.deepReadsPerDay)} full code reviews a day, shared by everyone using this. ` +
    `A scan reads ${String(repos)} ${repos === 1 ? "repository" : "repositories"} line by line, ` +
    "and fewer when the shared budget is already spent. Every repository that is not a fork gets the secret scan.";
  quotaSub.textContent =
    "Free and open source, run by one person. The daily ceiling is small on purpose and resets overnight.";
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
    quotaSub.textContent =
      "The secret scan does not depend on it and still runs on every repository that is not a fork.";
  });

/**
 * A report that is not there.
 *
 * The heading and the agent panel used to keep saying "Scan in progress" and
 * "Idle, 0 percent, enter a username to start" underneath the message, because
 * both are only ever written from a summary that this path never receives.
 */
function showUnavailable(): void {
  setScanState("failed");
  statusTitle.textContent = "Report not found";
  liveStatus.textContent =
    "That report link is not valid, or it has passed its 30 day expiry and been deleted.";
  livePhase.textContent = "Not found";
  livePercent.textContent = "";
  liveBar.style.width = "0%";
  liveDetail.textContent = "Enter a username above to run a new scan.";
  botLive.dataset["state"] = "failed";
  signText.textContent = "Nothing to show";
  seeResults.hidden = true;
  verdict.hidden = true;
}

const existingRequest = new URLSearchParams(location.search).get("request");
if (existingRequest !== null) {
  // Someone arriving on a shared link came for the result, not for the form.
  document.body.dataset["view"] = "report";
  statusSection.hidden = false;
  const parsedRequest = opaqueIdSchema.safeParse(existingRequest);
  if (!parsedRequest.success) {
    showUnavailable();
  } else {
    setButtonBusy(true);
    setScanState("scanning");
    void poll(parsedRequest.data)
      .catch(() => {
        showUnavailable();
      })
      .finally(() => {
        setButtonBusy(false);
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
      what.className =
        entry.findings > 0 || entry.stopped === true ? "what hit" : "what";
      what.textContent = entry.stopped === true
        ? "stopped before it finished"
        : entry.complete
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

// Delegated on the document, so a chip the ledger adds later is covered too.
installTooltips();

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
  const decided = summarizeVerdict(
    summary.username,
    repositories,
    findings,
    summary.state === "failed" ? explainFailure(summary.reason) : undefined,
  );
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
    `${String(counted)} public ${counted === 1 ? "repository" : "repositories"} in the account · ` +
    `${findings === 0 ? "nothing found" : `${String(findings)} finding${findings === 1 ? "" : "s"}`} · ` +
    `scanned ${new Date(summary.updatedAt).toLocaleString()} · ` +
    `${branding.productDisplayName}`;
}
