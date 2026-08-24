import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (channels === null) throw new Error("invalid color token");
  const values = channels.slice(1).map((value) => channel(Number.parseInt(value, 16)));
  return 0.2126 * (values[0] ?? 0) + 0.7152 * (values[1] ?? 0) + 0.0722 * (values[2] ?? 0);
}

function contrast(left: string, right: string): number {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

function token(block: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (match?.[1] === undefined) throw new Error(`missing ${name} token`);
  return match[1];
}

describe("production accessibility invariants", () => {
  it("keeps scan-button text at WCAG AA contrast in both themes", async () => {
    const css = await readFile(new URL("src/style.css", root), "utf8");
    const light = /^:root\s*\{([\s\S]*?)\}/m.exec(css)?.[1];
    const dark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/m.exec(css)?.[1];
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    for (const block of [light ?? "", dark ?? ""]) {
      expect(contrast(token(block, "signal"), token(block, "signal-contrast"))).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toMatch(/\.input-row button\s*\{[^}]*color:\s*var\(--signal-contrast\)/s);
  });

  it("keeps every text token at WCAG AA on both page surfaces", async () => {
    // --muted-dim shipped at #767c85 under a comment claiming it "still clears
    // 4.5:1". It measures 4.21:1 on --paper-raised and 4.02:1 on --paper, and
    // it colours the ten and eleven pixel step numbers and labels, where 4.5:1
    // is the threshold that applies.
    const css = await readFile(new URL("src/style.css", root), "utf8");
    const light = /^:root\s*\{([\s\S]*?)\}/m.exec(css)?.[1] ?? "";
    const dark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/m.exec(css)?.[1] ?? "";
    for (const block of [light, dark]) {
      for (const ink of ["ink", "muted", "muted-dim"]) {
        for (const paper of ["paper", "paper-raised"]) {
          const ratio = contrast(token(block, ink), token(block, paper));
          expect(
            ratio,
            `--${ink} on --${paper} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("lets a 39 character username wrap inside the verdict box", async () => {
    // The verdict prints the username, GitHub allows 39 characters, and one
    // with no hyphen is a single unbreakable run in a flex row. Measured in
    // Chrome at 320px: the document came out wider than the viewport, with the
    // name painted past the right edge of its own red box and a horizontal
    // scrollbar under the whole page. Only `anywhere` fixes it, because it is
    // the one value that shrinks the flex item's min-content, so this asserts
    // the value rather than merely the presence of a wrap.
    const css = await readFile(new URL("src/style.css", root), "utf8");
    const rules = [...css.matchAll(/(^|\n)(\.verdict|#verdict-text)\s*\{([^}]*)\}/g)];
    expect(rules.length, "no rule styles the verdict").toBeGreaterThan(0);
    const wraps = rules.filter((rule) => /overflow-wrap:\s*anywhere/.test(rule[3] ?? ""));
    expect(wraps.length, "a long username cannot break out of the verdict").toBeGreaterThan(0);
    // Asserted over every matching rule rather than one of them, for the same
    // reason the running-row guard carries: a single-declaration assertion
    // passed there while a second rule further down the file put the wrong
    // value back. `break-word` and `normal` both measured a document wider
    // than a 320px viewport, so either arriving later is the whole defect
    // again with a green test over it.
    for (const rule of rules) {
      const body = rule[3] ?? "";
      expect(body, `a later verdict rule undoes the wrap: ${body.trim()}`).not.toMatch(
        /overflow-wrap:\s*(normal|break-word)/,
      );
    }
  });

  it("gives the findings table a row header, as the ledger has", async () => {
    // Every findings cell was a plain td, including the repository name, so
    // navigating that table cell by cell never re-announced which repository
    // you were in. It is the six column one, where that matters most, and the
    // ledger beside it has had a row header all along.
    const script = await readFile(new URL("src/main.ts", root), "utf8");
    expect(script).toContain('document.createElement(index === 0 ? "th" : "td")');
    expect(script).toContain('cell.setAttribute("scope", "row")');
  });

  it("exposes and updates the theme toggle pressed state", async () => {
    const [html, script] = await Promise.all([
      readFile(new URL("index.html", root), "utf8"),
      readFile(new URL("src/main.ts", root), "utf8"),
    ]);
    expect(html).toMatch(/id="theme-toggle"[^>]*aria-pressed="false"/);
    expect(script).toContain('themeToggle.setAttribute("aria-pressed", String(dark))');
  });

  it("loads public findings without login routes", async () => {
    const [html, script] = await Promise.all([
      readFile(new URL("index.html", root), "utf8"),
      readFile(new URL("src/main.ts", root), "utf8"),
    ]);
    // The findings section exists and is reachable without any login route.
    // Pinned by id rather than by heading text, so rewording the page does not
    // read as a regression in the login guard this test is really about.
    expect(html).toContain('id="findings-section"');
    expect(html).toContain('id="finding-rows"');
    expect(html).not.toContain("owner-gate");
    expect(html).not.toContain("/auth/github");
    expect(script).toContain(
      "`/api/scan-requests/${requestId}/findings${query}`",
    );
    expect(script).not.toContain("/api/owner/");
  });
});
