import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeWhen,
  forgetScan,
  readHistory,
  rememberScan,
  type HistoryEntry,
} from "../src/history.js";

/**
 * Local history has to survive hostile storage, because a meaningful share of
 * visitors browse with site data blocked or in a private window. Every one of
 * those cases throws, and a history list must never be the reason the page
 * fails to load, so the failure assertions here matter more than the happy path.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  } as Storage;
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    requestId: "req_0000000001",
    username: "ri7in",
    at: 1_000,
    findings: 0,
    repositories: 3,
    complete: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scan history", () => {
  it("remembers a scan and reads it back", () => {
    rememberScan(entry());
    expect(readHistory()).toHaveLength(1);
    expect(readHistory()[0]?.username).toBe("ri7in");
  });

  it("replaces an earlier entry for the same report rather than duplicating", () => {
    // Written on every poll, so the same report is stored many times per run.
    rememberScan(entry({ complete: false, findings: 0 }));
    rememberScan(entry({ complete: true, findings: 2 }));
    const stored = readHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.complete).toBe(true);
    expect(stored[0]?.findings).toBe(2);
  });

  it("keeps the newest scan first", () => {
    rememberScan(entry({ requestId: "req_0000000001", username: "first" }));
    rememberScan(entry({ requestId: "req_0000000002", username: "second" }));
    expect(readHistory()[0]?.username).toBe("second");
  });

  it("caps the list so storage cannot grow without bound", () => {
    for (let index = 0; index < 40; index += 1) {
      rememberScan(entry({ requestId: `req_${String(index).padStart(10, "0")}` }));
    }
    expect(readHistory().length).toBeLessThanOrEqual(25);
  });

  it("forgets one scan without disturbing the others", () => {
    rememberScan(entry({ requestId: "req_0000000001" }));
    rememberScan(entry({ requestId: "req_0000000002" }));
    forgetScan("req_0000000001");
    const stored = readHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.requestId).toBe("req_0000000002");
  });

  it("drops a corrupt entry instead of the whole list", () => {
    localStorage.setItem(
      "scan-history-v1",
      JSON.stringify([entry(), { requestId: 42 }, entry({ requestId: "req_0000000009" })]),
    );
    expect(readHistory()).toHaveLength(2);
  });

  it("returns an empty list when the stored value is not JSON", () => {
    localStorage.setItem("scan-history-v1", "{{{not json");
    expect(readHistory()).toEqual([]);
  });

  it("returns an empty list when storage itself throws", () => {
    // A private window or blocked site data throws on access, not on read.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage);
    expect(readHistory()).toEqual([]);
  });

  it("still reports the new list when a write is refused", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    } as unknown as Storage);
    // The page must still render the entry it just created.
    expect(rememberScan(entry())).toHaveLength(1);
  });
});

describe("describing when a scan ran", () => {
  const now = 1_000_000_000_000;
  const minute = 60_000;

  it("reads as recent within the first minute", () => {
    expect(describeWhen(now - 5_000, now)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(describeWhen(now - 5 * minute, now)).toBe("5 min ago");
    expect(describeWhen(now - 3 * 60 * minute, now)).toBe("3h ago");
    expect(describeWhen(now - 24 * 60 * minute, now)).toBe("yesterday");
    expect(describeWhen(now - 3 * 24 * 60 * minute, now)).toBe("3 days ago");
  });

  it("switches to a date once relative time stops being useful", () => {
    const older = describeWhen(now - 30 * 24 * 60 * minute, now);
    expect(older).not.toContain("ago");
    expect(older).not.toBe("yesterday");
  });

  it("never reports a future timestamp as negative", () => {
    expect(describeWhen(now + 60_000, now)).toBe("just now");
  });
});
