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
const requestIdLabel = $<HTMLElement>("#request-id");
const botCode = $<HTMLElement>("#bot-code");
const ledgerNote = $<HTMLElement>("#ledger-note");
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
    const terminal = summary.state === "complete" || summary.state === "failed";
    const repositories = await loadRepositories(requestId, terminal);
    renderRepositories(repositories);
    ledgerSection.hidden = false;
    if (terminal) {
      try {
        renderFindings(await loadFindings(requestId), repositories);
      } catch {
        // Finding detail is a separate public-safe plane. Its failure must never
        // relabel a valid coverage request as failed.
        findingsSection.hidden = true;
        findingRows.replaceChildren();
      }
    }
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

  if (!budget.available) {
    quotaLine.textContent =
      "Deep read is used up for today. Every repository still gets the full secret scan.";
    quotaSub.textContent = `The daily allowance resets at 00:00 UTC. Add your own model key to read without the shared limit.`;
    return;
  }

  const repos = budget.repoLimitPerRequest;
  quotaLine.textContent =
    `${String(budget.deepReadsRemaining)} of ${String(budget.deepReadsPerDay)} deep reads left today. ` +
    `Each scan reads your ${String(repos)} most recently committed ${repos === 1 ? "repository" : "repositories"} in full; the rest get the secret scan.`;
  quotaSub.textContent = budget.limitsVerified
    ? `Limited by ${budget.scarcestModelId}, the tightest free allowance in the council.`
    : `Limited by ${budget.scarcestModelId}. One member's published limit is unconfirmed upstream, so treat this figure as provisional.`;
}

void requestJson("/api/capabilities")
  .then((value) => {
    const capabilities = publicCapabilitiesSchema.parse(value);
    emailEnabled = capabilities.emailNotifications;
    emailOption.hidden = !emailEnabled;
    renderDeepReadBudget(capabilities.deepRead);
    serviceNote.textContent =
      capabilities.scanCreation === "public"
        ? "No install. No card. No target code is executed. Reports update live; queue time depends on current worker capacity."
        : `Private production preview: scan creation is currently limited to the operator account while the public isolation worker is commissioned. Existing report links remain public.`;
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
