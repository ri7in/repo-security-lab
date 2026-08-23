import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards on the words that ship, not on the code that renders them.
 *
 * Two of these exist because the drift actually happened and nothing failed:
 * the privacy policy told visitors "the AI source lane is disabled" for a full
 * day after the AI review went live and started sending source to two external
 * providers, and the footer's "Exactly what is sent" link pointed at a
 * fragment the target page had never had.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WEB = path.join(ROOT, "apps/web");

function read(relative: string): string {
  return readFileSync(path.join(WEB, relative), "utf8");
}

const PAGES = [
  "index.html",
  "public/privacy.html",
  "public/acceptable-use.html",
];

describe("links between the shipped pages", () => {
  it("finds links to check, so this guard cannot pass vacuously", () => {
    const links = PAGES.flatMap((page) => [
      ...read(page).matchAll(/href="(\/[^"]*)"/g),
    ]);
    expect(links.length).toBeGreaterThan(4);
  });

  it("resolves every internal link to a page that exists", () => {
    const available = new Set([
      "/",
      ...readdirSync(path.join(WEB, "public")).map((name) => `/${name}`),
    ]);
    const broken: string[] = [];
    for (const page of PAGES) {
      for (const match of read(page).matchAll(/href="(\/[^"#]*)(#[^"]*)?"/g)) {
        const target = match[1] ?? "";
        if (target === "" || available.has(target)) continue;
        broken.push(`${page} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("resolves every fragment to an id on the page it points at", () => {
    const broken: string[] = [];
    for (const page of PAGES) {
      for (const match of read(page).matchAll(/href="(\/[^"#]*)#([^"]+)"/g)) {
        const target = match[1] === "/" ? "index.html" : `public${match[1] ?? ""}`;
        let body: string;
        try {
          body = read(target);
        } catch {
          broken.push(`${page} -> missing page ${target}`);
          continue;
        }
        if (!body.includes(`id="${match[2] ?? ""}"`)) {
          broken.push(`${page} -> ${match[1] ?? ""}#${match[2] ?? ""}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("the privacy policy", () => {
  it("says the code review sends source out, while it does", () => {
    // The default is on, so the policy has to say so. If the reader is ever
    // removed for good, delete this test in the same commit and not before.
    const config = readFileSync(
      path.join(ROOT, "apps/scan-worker/src/runtime-config.ts"),
      "utf8",
    );
    const readerRunsByDefault = config.includes(
      'environment["AI_REVIEW_ENABLED"] === "false"',
    );
    expect(readerRunsByDefault).toBe(true);

    const privacy = read("public/privacy.html").toLowerCase();
    expect(privacy).toContain("sends source files");
    expect(privacy).toContain("openrouter");
    expect(privacy).toContain("groq");
    // The exact sentence that was live and false.
    expect(privacy).not.toContain("ai source lane is disabled");
    expect(privacy).not.toContain("no repository source code is sent");
  });

  it("says the providers may keep what they receive", () => {
    // The thing a reader most needs to know, and the thing a policy is most
    // tempted to leave out.
    expect(read("public/privacy.html").toLowerCase()).toContain("retain or train");
  });

  it("does not describe a preview that ended", () => {
    const privacy = read("public/privacy.html").toLowerCase();
    expect(privacy).not.toContain("private preview");
  });
});

describe("acceptable use", () => {
  it("addresses scanning an account you do not own", () => {
    // The homepage invites it in as many words, so the policy cannot be silent
    // about it.
    const page = read("public/acceptable-use.html").toLowerCase();
    expect(page).toContain("any public github account");
    expect(page).toContain("tell them");
  });
});

describe("the two dark palettes", () => {
  it("define exactly the same tokens with the same values", () => {
    // One block serves an explicit choice and the other serves a machine
    // already in dark mode. They are duplicated on purpose, so they are also
    // checked against each other rather than trusted to stay in step.
    const css = read("src/style.css");
    const explicit = /:root\[data-theme="dark"\] \{\n([\s\S]*?)\n\}/.exec(css);
    const system =
      /@media \(prefers-color-scheme: dark\) \{\n\s*:root:not\(\[data-theme="light"\]\) \{\n([\s\S]*?)\n\s*\}\n\}/.exec(
        css,
      );
    expect(explicit).not.toBeNull();
    expect(system).not.toBeNull();
    const tokens = (body: string): string =>
      body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join("\n");
    expect(tokens(system?.[1] ?? "")).toBe(tokens(explicit?.[1] ?? ""));
    expect(tokens(explicit?.[1] ?? "")).toContain("--paper:");
  });

  it("does not leave the page following the system with no dark palette", () => {
    // The meta tag advertises both schemes, so without this rule the browser
    // renders dark form controls and scrollbars against a white page.
    expect(read("src/style.css")).toContain("@media (prefers-color-scheme: dark)");
    expect(read("index.html")).toContain('content="light dark"');
  });
});

describe("the owner's hard rule about em dashes", () => {
  it("finds no em dash in anything that ships", () => {
    const offenders: string[] = [];
    const roots = [
      path.join(WEB, "src"),
      path.join(WEB, "public"),
      path.join(WEB, "index.html"),
    ];
    const walk = (target: string): void => {
      let entries;
      try {
        entries = readdirSync(target, { withFileTypes: true });
      } catch {
        // A file rather than a directory.
        const body = readFileSync(target, "utf8");
        if (body.includes("—")) offenders.push(target);
        return;
      }
      for (const entry of entries) {
        const next = path.join(target, entry.name);
        if (entry.isDirectory()) {
          walk(next);
          continue;
        }
        if (!/\.(ts|html|css)$/.test(entry.name)) continue;
        if (readFileSync(next, "utf8").includes("—")) offenders.push(next);
      }
    };
    for (const target of roots) walk(target);
    expect(offenders).toEqual([]);
  });
});
