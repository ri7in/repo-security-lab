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
    expect(html).toContain("PUBLIC FINDING REPORT");
    expect(html).not.toContain("owner-gate");
    expect(html).not.toContain("/auth/github");
    expect(script).toContain(
      "`/api/scan-requests/${requestId}/findings${query}`",
    );
    expect(script).not.toContain("/api/owner/");
  });
});
