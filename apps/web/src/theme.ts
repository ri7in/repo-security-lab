/**
 * Light or dark, remembered.
 *
 * The toggle used to set an attribute and nothing else, so the choice lasted
 * until the next page load and the system preference was ignored entirely: a
 * visitor whose machine is in dark mode opened a white page and had to find
 * the button every time.
 *
 * Storage is best effort. A private window, cleared site data, or a browser
 * set to block storage all throw on access, and none of that is a reason for
 * the page to fail, so every read and write is guarded and the system
 * preference is the fallback.
 */

/** Matches the history key's shape: product-neutral, versioned. */
const KEY = "theme-v1";

export type Theme = "light" | "dark";

export function readStoredTheme(
  storage: Pick<Storage, "getItem"> | undefined,
): Theme | null {
  try {
    const value = storage?.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function storeTheme(
  storage: Pick<Storage, "setItem"> | undefined,
  theme: Theme,
): void {
  try {
    storage?.setItem(KEY, theme);
  } catch {
    // Nothing to do and nothing worth telling the visitor. The choice simply
    // lasts for this page rather than for this browser.
  }
}

/**
 * The theme to open with.
 *
 * An explicit choice always wins. With no choice stored, the system preference
 * decides, and returning null rather than a theme is deliberate: leaving the
 * attribute off is what lets the stylesheet's media query keep following the
 * system if the visitor changes it while the page is open.
 */
export function initialTheme(
  stored: Theme | null,
  systemPrefersDark: boolean,
): { readonly attribute: Theme | null; readonly dark: boolean } {
  if (stored !== null) return { attribute: stored, dark: stored === "dark" };
  return { attribute: null, dark: systemPrefersDark };
}
