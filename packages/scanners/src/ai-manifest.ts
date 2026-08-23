import { AI_CWE_IDS } from "@app/contracts";

/**
 * Structural copy of the broker's manifest entry.
 *
 * Declared here rather than imported so this package does not take a
 * dependency on the broker purely for a type. The broker validates every field
 * on construction, so a drift between the two shapes fails loudly at startup
 * rather than silently.
 */
export interface AiManifestEntry {
  readonly token: number;
  readonly ruleId: string;
  readonly category: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "info" | "unknown";
  readonly confidence: "high" | "medium" | "low" | "unknown";
  readonly remediationKey: string;
}

/**
 * The manifest the AI engine's findings are brokered through.
 *
 * A model is untrusted input, so its output crosses the same boundary a
 * scanner's does: it may name a numeric token from this table and nothing
 * else. It cannot invent a rule id, a severity, a category, or a line of
 * prose, because none of those travel. They are all looked up here from the
 * token, exactly as they are for gitleaks.
 *
 * The vocabulary is the ten CWE classes the scout prompt allows, which is why
 * it is small and closed. A model that reports something outside it is
 * rejected at the schema before it ever reaches the broker.
 */

/** Human wording for each class, keyed by CWE. Never model-supplied. */
const DESCRIPTIONS: Record<(typeof AI_CWE_IDS)[number], string> = {
  "CWE-22": "path-traversal",
  "CWE-78": "command-injection",
  "CWE-79": "cross-site-scripting",
  "CWE-89": "sql-injection",
  "CWE-94": "code-injection",
  "CWE-287": "broken-authentication",
  "CWE-352": "cross-site-request-forgery",
  "CWE-502": "unsafe-deserialization",
  "CWE-918": "server-side-request-forgery",
  "CWE-1321": "prototype-pollution",
};

/**
 * Remediation keys, deliberately per-class.
 *
 * A single "review this" key would make every AI finding say the same
 * unhelpful thing. These are fixed strings the report renders; the model has
 * no say in which one appears beyond naming the class.
 */
const REMEDIATIONS: Record<(typeof AI_CWE_IDS)[number], string> = {
  "CWE-22": "validate-path-input",
  "CWE-78": "avoid-shell-interpolation",
  "CWE-79": "escape-output",
  "CWE-89": "use-parameterised-queries",
  "CWE-94": "avoid-dynamic-evaluation",
  "CWE-287": "verify-ownership",
  "CWE-352": "require-csrf-token",
  "CWE-502": "avoid-untrusted-deserialization",
  "CWE-918": "restrict-outbound-requests",
  "CWE-1321": "guard-prototype-keys",
};

/**
 * Severity per class, fixed here rather than taken from the model.
 *
 * Letting a model grade its own finding is how a report ends up full of
 * criticals. These reflect what the class can do at worst, and the council's
 * job is to decide whether the finding is real, not how bad it is.
 */
const SEVERITIES: Record<
  (typeof AI_CWE_IDS)[number],
  AiManifestEntry["severity"]
> = {
  "CWE-22": "high",
  "CWE-78": "critical",
  "CWE-79": "medium",
  "CWE-89": "critical",
  "CWE-94": "critical",
  "CWE-287": "high",
  "CWE-352": "medium",
  "CWE-502": "high",
  "CWE-918": "high",
  "CWE-1321": "medium",
};

export const AI_BROKER_MANIFEST: readonly AiManifestEntry[] = Object.freeze(
  AI_CWE_IDS.map((cwe, index) =>
    Object.freeze({
      token: index + 1,
      // The rule id a reader sees: the class name, not the bare number.
      ruleId: `${cwe.toLowerCase()}-${DESCRIPTIONS[cwe]}`,
      category: "code",
      severity: SEVERITIES[cwe],
      // Every AI finding survived a scout, a grounding gate that requires it
      // to quote real source, and a council vote. "medium" reflects that it is
      // reasoned rather than pattern-matched, and is never model-supplied.
      confidence: "medium" as const,
      remediationKey: REMEDIATIONS[cwe],
    }),
  ),
);

/** The token for a CWE, or null if it is outside the closed vocabulary. */
export function aiCweToken(cwe: string): number | null {
  const index = AI_CWE_IDS.indexOf(cwe as (typeof AI_CWE_IDS)[number]);
  return index === -1 ? null : index + 1;
}
