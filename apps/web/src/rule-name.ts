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
  const named = AI_RULE_NAMES[ruleId];
  if (named !== undefined) return named;
  // A class that reaches here without an entry still must not show its
  // catalogue number, so the prefix goes even on the fallback path.
  const withoutCwe = /^cwe-\d+-(.+)$/.exec(ruleId);
  if (withoutCwe?.[1] !== undefined) {
    return withoutCwe[1].replaceAll("-", " ");
  }
  return ruleId.replaceAll("-", " ");
}
