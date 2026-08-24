import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ruleName } from "../src/rule-name.js";

/**
 * The column that answers "what was found" printed the rule id with its
 * hyphens swapped for spaces, so an AI finding read "cwe 89 sql injection".
 * The catalogue number is the first thing on the line and it tells a reader
 * nothing they can act on.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The manifest's rule ids, read from its source rather than imported.
 *
 * apps/web deliberately depends on @app/branding and @app/contracts only, and
 * a test is not a reason to widen what the browser bundle can reach.
 */
function manifestRuleIds(): readonly string[] {
  const source = readFileSync(
    path.join(ROOT, "packages/scanners/src/ai-manifest.ts"),
    "utf8",
  );
  const block = /const DESCRIPTIONS[^=]*=\s*\{([\s\S]*?)\};/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/"(CWE-\d+)":\s*"([a-z-]+)"/g)].map(
    (match) => `${(match[1] ?? "").toLowerCase()}-${match[2] ?? ""}`,
  );
}

describe("what a finding is called", () => {
  it("gives every class the AI manifest can publish a real name", () => {
    // A class with no entry falls back to the slug, which is how the CWE
    // number crept in. This catches a new class being added upstream and
    // never being named here.
    const ids = manifestRuleIds();
    expect(ids.length, "no rule ids were read").toBe(10);
    for (const ruleId of ids) {
      const name = ruleName(ruleId);
      expect(name, `${ruleId} has no name`).not.toBe(ruleId);
      expect(name, `${ruleId} still shows its number`).not.toMatch(/cwe/i);
      expect(name[0], `${ruleId} is not capitalised`).toBe(name[0]?.toUpperCase());
    }
  });

  it("names the two a reader is most likely to meet", () => {
    expect(ruleName("cwe-89-sql-injection")).toBe("SQL injection");
    expect(ruleName("cwe-918-server-side-request-forgery")).toBe(
      "Server-side request forgery",
    );
  });

  it("leaves a secret scanner rule as the vendor name it is", () => {
    // "generic api key" and "aws access key" are exactly what a reader wants
    // to see, and there are two hundred and twenty-two of them.
    // Sentence-cased: lowercase machine text beside "SQL injection" read as
    // a bug rather than a name.
    expect(ruleName("generic-api-key")).toBe("Generic api key");
    expect(ruleName("aws-access-token")).toBe("Aws access token");
  });

  it("drops the catalogue number even on the fallback path", () => {
    expect(ruleName("cwe-999-something-new")).toBe("Something new");
  });
});

describe("workflow audit rule names", () => {
  it("names every ident in the pinned zizmor manifest", () => {
    // "artipacked" reached a live report as a raw slug. The vocabulary is a
    // closed 37-entry set, so every ident gets a written name and a scanner
    // upgrade that adds one fails here instead of shipping jargon.
    const manifest = readFileSync(
      path.join(ROOT, "packages/scanners/src/zizmor-manifest.ts"),
      "utf8",
    );
    const idents = [...manifest.matchAll(/\[\s*"([a-z0-9-]+)"\s*,/g)].map(
      (match) => match[1] ?? "",
    );
    expect(idents.length).toBeGreaterThan(30);
    for (const ident of idents) {
      const name = ruleName(ident);
      expect(name, `${ident} has no written name`).not.toBe(
        ident.replaceAll("-", " "),
      );
      expect(name.length, `${ident} name too short`).toBeGreaterThan(10);
    }
  });
});

