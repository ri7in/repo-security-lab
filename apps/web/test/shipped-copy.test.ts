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

describe("the public documentation", () => {
  const docs = (relative: string): string =>
    readFileSync(path.join(ROOT, relative), "utf8");

  it("does not claim a model can never suppress a scanner finding", () => {
    // The council deletes a secret-scan finding when every judge rejects it.
    // The README, the threat model and the landing page all said otherwise.
    for (const file of ["README.md", "docs/threat-model.md"]) {
      const body = docs(file).toLowerCase();
      expect(body, file).not.toContain("may never suppress");
      expect(body, file).not.toContain("immutable evidence;");
    }
  });

  it("does not describe itself as a private preview", () => {
    // Anyone can scan any public account, and both the site and the API say so.
    for (const file of ["README.md", "docs/threat-model.md", "docs/privacy.md"]) {
      expect(docs(file).toLowerCase(), file).not.toContain("private production preview");
    }
  });

  it("says source is sent to model providers", () => {
    expect(docs("docs/privacy.md").toLowerCase()).toContain("is sent to model providers");
    expect(docs("docs/privacy.md").toLowerCase()).not.toContain("ai source lane remains disabled");
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

describe("claims the code contradicts", () => {
  it("does not say a model can never delete a scanner finding", () => {
    // It can, and it does, on every scan: two judges that both call a
    // secret-scan finding a false alarm remove it. The landing page said the
    // opposite in as many words.
    const page = read("index.html").toLowerCase();
    expect(page).not.toContain("never delete one the secret scanner");
    expect(page).not.toContain("can never hide");
    expect(page).toContain("only when both call it a false alarm");
  });

  it("names every provider that can receive code", () => {
    // The footer named the budgeted providers, and Google is deliberately
    // unbudgetable because its free limits are no longer published, so a
    // second judge was reading excerpts on every scan undisclosed.
    const privacy = read("public/privacy.html").toLowerCase();
    for (const provider of ["openrouter", "groq", "google"]) {
      expect(privacy, `${provider} is undisclosed`).toContain(provider);
    }
  });

  it("says the excerpt path exists, not only the reader path", () => {
    // Two different things leave the machine: whole files to the reader, and a
    // window around each secret-scan finding to both judges.
    expect(read("public/privacy.html").toLowerCase()).toContain("excerpt");
    expect(read("index.html").toLowerCase()).toContain("excerpt");
  });

  it("does not present the daily ceiling as a live reading", () => {
    // Nothing records what a scan spends, so "16 of 16 left today" was a
    // constant dressed as a gauge.
    const script = read("src/main.ts");
    expect(script).not.toContain("full code reviews left today");
    expect(script).toContain("Up to ${String(budget.deepReadsPerDay)} full code reviews a day");
  });

  it("does not promise the secret scan runs on every repository", () => {
    // Forks are published cancelled with every check not applicable, and no
    // archive is ever downloaded for them.
    const script = read("src/main.ts");
    expect(script).not.toContain("still runs on every repository.");
    expect(script).not.toContain("Every repository still gets the secret scan");
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

describe("the privacy page lists what is actually stored", () => {
  it("discloses the country code, because a row carries one", () => {
    // apps/api/src/app.ts reads cf-ipcountry and writes it to the request row,
    // and deploy/usage-log.sh prints it. The page listed the username, the
    // repository names and the commit hashes, and said only that IP addresses
    // are not persisted, which reads as "nothing about where you are".
    const privacy = readFileSync(path.join(WEB, "public/privacy.html"), "utf8");
    expect(privacy.toLowerCase()).toContain("country code");
    expect(readFileSync(path.join(ROOT, "apps/api/src/app.ts"), "utf8")).toContain(
      'context.req.header("cf-ipcountry")',
    );
  });
});

describe("colour never claims more than the words do", () => {
  it("does not leave the all-clear green on a scan that read nothing", () => {
    // .nothing-found is green, and its own CSS comment says green means a
    // check ran and found nothing. Over an account with no public
    // repositories nothing ran, and the box still rendered green directly
    // under an amber verdict saying there was nothing to check.
    const script = read("src/main.ts");
    expect(script).toContain(
      'nothingFound.classList.toggle("is-neutral", repositories.length === 0)',
    );
    expect(read("src/style.css")).toContain(".nothing-found.is-neutral");
  });
});

describe("the owner's hard rule about em dashes", () => {
  it("finds no em dash anywhere in the repository", () => {
    // Was scoped to apps/web, which let twenty-seven of them accumulate in
    // README.md and docs/ where the rule applies just as hard: the README is
    // the first page anyone visiting the public repository reads.
    const SKIP_DIRECTORIES = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      "coverage",
      ".wrangler",
      ".turbo",
    ]);
    // The two files that must contain the character are the guards themselves.
    const ALLOWED = new Set([
      path.join(ROOT, "apps/web/test/shipped-copy.test.ts"),
      path.join(ROOT, "apps/web/test/remediation.test.ts"),
    ]);
    const TEXT = /\.(ts|tsx|js|mjs|html|css|md|json|yml|yaml|sh|sql|toml)$/;

    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const next = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name)) walk(next);
          continue;
        }
        if (!entry.isFile() || !TEXT.test(entry.name) || ALLOWED.has(next)) continue;
        if (readFileSync(next, "utf8").includes("\u2014")) {
          offenders.push(path.relative(ROOT, next));
        }
      }
    };
    walk(ROOT);
    expect(offenders).toEqual([]);
  });
});
