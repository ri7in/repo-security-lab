import { describe, expect, it } from "vitest";
import { initialTheme, readStoredTheme, storeTheme } from "../src/theme.js";

/**
 * The theme has to survive a page load and has to notice a machine that is
 * already in dark mode. It did neither: the toggle set an attribute and
 * nothing else, and the stylesheet had no media query at all, so a visitor in
 * dark mode opened a white page and had to find the button again every time.
 */

function storage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

function throwingStorage(): Storage {
  return {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;
}

describe("remembering a theme", () => {
  it("keeps a choice across a page load", () => {
    const store = storage();
    storeTheme(store, "dark");
    expect(readStoredTheme(store)).toBe("dark");
  });

  it("survives a browser that refuses storage", () => {
    // A private window, cleared site data, or a browser set to block storage
    // all throw on access. None of that is a reason for the page to fail.
    expect(() => {
      storeTheme(throwingStorage(), "dark");
    }).not.toThrow();
    expect(readStoredTheme(throwingStorage())).toBeNull();
    expect(readStoredTheme(undefined)).toBeNull();
  });

  it("ignores a stored value that is not a theme", () => {
    expect(
      readStoredTheme(storage({ "theme-v1": "purple" })),
    ).toBeNull();
    expect(readStoredTheme(storage({ "theme-v1": "" }))).toBeNull();
  });
});

describe("choosing the opening theme", () => {
  it("follows the system when nobody has chosen", () => {
    expect(initialTheme(null, true)).toEqual({ attribute: null, dark: true });
    expect(initialTheme(null, false)).toEqual({ attribute: null, dark: false });
  });

  it("leaves the attribute off so the page can keep following the system", () => {
    // Writing "dark" here would freeze the page against a visitor who changes
    // their system setting while it is open.
    expect(initialTheme(null, true).attribute).toBeNull();
  });

  it("lets an explicit choice win over the system", () => {
    expect(initialTheme("light", true)).toEqual({
      attribute: "light",
      dark: false,
    });
    expect(initialTheme("dark", false)).toEqual({
      attribute: "dark",
      dark: true,
    });
  });
});
