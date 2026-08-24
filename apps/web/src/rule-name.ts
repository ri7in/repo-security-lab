/**
 * What a finding is called, in words a reader has a chance with.
 *
 * The column printed the rule id with its hyphens swapped for spaces, so an
 * AI finding read "cwe 89 sql injection" and "cwe 918 server side request
 * forgery". The CWE number is catalogue jargon: it tells a reader nothing they
 * can act on and it is the first thing on the line.
 *
 * The ten AI classes are a closed set, fixed on the trusted side, so they get
 * real names here and a guard test refuses a manifest entry without one. The
 * secret scanner's ids are vendor rule names, and "generic api key" or
 * "aws access key" is exactly what a reader wants to see, so those keep the
 * hyphen swap rather than growing a table of two hundred and twenty-two.
 */

/**
 * The workflow auditor's idents, named for a reader.
 *
 * zizmor's vocabulary is a closed 37-entry set fixed by the pinned manifest,
 * so it gets the same treatment as the AI classes: every ident has a written
 * name, and a guard test walks the manifest so a scanner upgrade that adds an
 * ident cannot ship a raw slug like "artipacked" to a report.
 */
const ZIZMOR_RULE_NAMES: Record<string, string> = {
  "impostor-commit": "Action pinned to a commit from the wrong repository",
  "adhoc-packages": "Workflow installs packages ad hoc",
  "anonymous-definition": "Workflow has no name",
  "archived-uses": "Workflow uses an archived action",
  "artipacked": "Workflow can leak its own credentials into artifacts",
  "bot-conditions": "Workflow trusts a spoofable bot identity",
  "cache-poisoning": "Workflow cache can be poisoned",
  "concurrency-limits": "Workflow has no concurrency limit",
  "dangerous-triggers": "Workflow runs on a dangerous trigger",
  "dependabot-cooldown": "Dependabot updates have no cooldown",
  "dependabot-execution": "Dependabot allows external code execution",
  "excessive-permissions": "Workflow asks for more permissions than it uses",
  "forbidden-uses": "Workflow uses a disallowed action",
  "github-app": "Workflow mints an over-broad GitHub App token",
  "github-env": "Workflow writes dangerously to GITHUB_ENV or GITHUB_PATH",
  "hardcoded-container-credentials": "Container registry password written into the workflow",
  "insecure-commands": "Workflow enables insecure legacy commands",
  "insecure-url-scheme": "Workflow fetches over plain HTTP",
  "misfeature": "Workflow relies on a misfeature",
  "obfuscation": "Workflow contains obfuscated content",
  "overprovisioned-secrets": "Workflow is handed more secrets than it uses",
  "ref-version-mismatch": "Action comment names a different version than its pin",
  "secrets-inherit": "Workflow passes every secret to a reusable workflow",
  "secrets-outside-env": "Secret used outside an env block",
  "self-hosted-runner": "Public workflow runs on a self-hosted runner",
  "superfluous-actions": "Workflow uses an action the runner already provides",
  "template-injection": "Workflow template injection",
  "typosquat-uses": "Workflow uses a likely typosquatted action",
  "undocumented-permissions": "Workflow permissions are undocumented",
  "unpinned-images": "Container image is not pinned",
  "unpinned-tools": "Tool version is not pinned",
  "unpinned-uses": "Action version is not pinned",
  "unredacted-secrets": "Secret value can reach the workflow log unredacted",
  "unsound-condition": "Workflow if-condition is always true",
  "unsound-contains": "Workflow contains() check can be fooled",
  "unsound-ternary": "Workflow ternary expression is unsound",
  "use-trusted-publishing": "Package publish could use trusted publishing instead of a token",
};

const AI_RULE_NAMES: Record<string, string> = {
  "cwe-22-path-traversal": "Path traversal",
  "cwe-78-command-injection": "Command injection",
  "cwe-79-cross-site-scripting": "Cross-site scripting",
  "cwe-89-sql-injection": "SQL injection",
  "cwe-94-code-injection": "Code injection",
  "cwe-287-broken-authentication": "Broken authentication",
  "cwe-352-cross-site-request-forgery": "Cross-site request forgery",
  "cwe-502-unsafe-deserialization": "Unsafe deserialization",
  "cwe-918-server-side-request-forgery": "Server-side request forgery",
  "cwe-1321-prototype-pollution": "Prototype pollution",
};

export function ruleName(ruleId: string): string {
  const named = AI_RULE_NAMES[ruleId] ?? ZIZMOR_RULE_NAMES[ruleId];
  if (named !== undefined) return named;
  // A class that reaches here without an entry still must not show its
  // catalogue number, so the prefix goes even on the fallback path.
  const withoutCwe = /^cwe-\d+-(.+)$/.exec(ruleId);
  if (withoutCwe?.[1] !== undefined) {
    return withoutCwe[1].replaceAll("-", " ");
  }
  return ruleId.replaceAll("-", " ");
}
