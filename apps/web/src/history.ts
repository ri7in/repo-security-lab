/**
 * Local scan history.
 *
 * Reports live at an unguessable URL and are deleted after 30 days, so a
 * visitor who closes the tab has genuinely lost the link. Nothing was stored
 * before this, which made the tool single-use by accident: the whole point is
 * that you fix a leak and scan again to confirm it is gone.
 *
 * This is per-browser and stays per-browser. It records the report id, the
 * username, when it finished, and the counts. It never records a finding, a
 * path, or anything about the code, because none of that needs to be in a
 * visitor's browser to make the list useful.
 *
 * Every read and write is wrapped: private windows, cleared site data, and
 * browsers configured to refuse storage all throw here, and a history feature
 * must never be the reason the page fails to load.
 */

const KEY = "scan-history-v1";
const MAX_ENTRIES = 25;

export interface HistoryEntry {
  readonly requestId: string;
  readonly username: string;
  /** Epoch milliseconds, stamped when the entry was last written. */
  readonly at: number;
  readonly findings: number;
  readonly repositories: number;
  readonly complete: boolean;
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["requestId"] === "string" &&
    typeof entry["username"] === "string" &&
    typeof entry["at"] === "number" &&
    typeof entry["findings"] === "number" &&
    typeof entry["repositories"] === "number" &&
    typeof entry["complete"] === "boolean"
  );
}

export function readHistory(): readonly HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // One corrupt entry drops itself, never the whole list.
    return parsed.filter(isEntry).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Records a scan, replacing any earlier entry for the same report.
 *
 * A scan is written as soon as it starts and rewritten as it progresses, so a
 * visitor who reloads mid-scan still finds their way back to it rather than
 * losing a run that is still going.
 */
export function rememberScan(entry: HistoryEntry): readonly HistoryEntry[] {
  const existing = readHistory().filter(
    (item) => item.requestId !== entry.requestId,
  );
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused. The list is still correct for this page view.
  }
  return next;
}

export function forgetScan(requestId: string): readonly HistoryEntry[] {
  const next = readHistory().filter((item) => item.requestId !== requestId);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Nothing further to do; the caller re-renders from the returned list.
  }
  return next;
}

/** "3 minutes ago", "yesterday", "12 Aug". Absolute once it stops being recent. */
export function describeWhen(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${String(days)} days ago`;
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
