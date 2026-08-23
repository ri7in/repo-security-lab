/**
 * What to actually do about a finding.
 *
 * The report used to print the remediation key with its hyphens swapped for
 * spaces, so the column that answers "what do I do now" said "rotate secret"
 * and left the reader to work out the rest. Two words is not advice.
 *
 * The keys are fixed on the trusted side and a model has no say in which one
 * appears, so this table is safe to write out in full. There are twelve of
 * them: two from the secret scanner and one per class in the AI manifest. A
 * guard test refuses any key that has no entry here, because a missing one
 * falls through to the slug and quietly reintroduces the problem.
 */

export interface Remediation {
  /** Fits a table cell. Imperative, and specific enough to act on. */
  readonly short: string;
  /** The whole answer, shown on hover and read out to a screen reader. */
  readonly detail: string;
}

const REMEDIATIONS: Record<string, Remediation> = {
  "rotate-secret": {
    short: "Rotate it",
    detail:
      "Treat this credential as compromised: anyone who cloned the repository has it. Issue a new one at the provider and revoke the old one first, then remove it from the file. Deleting the line is not enough on its own, because the value stays in git history until the history is rewritten.",
  },
  "harden-workflow": {
    short: "Harden the workflow",
    detail:
      "This GitHub Actions workflow can be influenced by something it should not trust, such as a pull request title or a branch name reaching a run step. Pin actions to a commit SHA, drop the permissions block to the least the job needs, and never interpolate untrusted input straight into a run command.",
  },
  "validate-path-input": {
    short: "Validate the path",
    detail:
      "A path is being built from input the caller controls, so a value like ../../etc/passwd can reach outside the directory you meant. Resolve the path first, then check the result is still inside the intended root, and reject it if it is not. Stripping \"..\" from the string is not enough.",
  },
  "avoid-shell-interpolation": {
    short: "Stop building a shell string",
    detail:
      "Input is being interpolated into a command line, so a semicolon or a backtick in that input runs a second command. Pass the program and its arguments as a list instead of handing a whole string to a shell, and do not enable shell mode.",
  },
  "escape-output": {
    short: "Escape the output",
    detail:
      "Untrusted text is reaching the page without being escaped, so a script tag in that text runs in your visitors' browsers. Insert it as text rather than as markup, and keep any templating engine's automatic escaping switched on.",
  },
  "use-parameterised-queries": {
    short: "Use a parameterised query",
    detail:
      "A value is being concatenated into SQL, so input can change what the query does rather than what it matches. Use placeholders and pass the values as parameters. Escaping quotes by hand is not a fix.",
  },
  "avoid-dynamic-evaluation": {
    short: "Stop evaluating input",
    detail:
      "Input is reaching something that executes it, such as eval, a dynamic import, or a template that runs code. Replace it with an explicit lookup or a parser that only accepts the shapes you meant to allow.",
  },
  "verify-ownership": {
    short: "Check who owns it",
    detail:
      "The code checks that someone is signed in but never that the record belongs to them, so any logged-in user can read or change another user's data by changing an id in the request. Load the record, compare its owner to the caller, and refuse if they differ.",
  },
  "require-csrf-token": {
    short: "Require a CSRF token",
    detail:
      "A state-changing request is accepted on the strength of a cookie alone, so another site can make a visitor's browser send it. Require a token the other site cannot read, or set the session cookie to SameSite=Lax or Strict.",
  },
  "avoid-untrusted-deserialization": {
    short: "Do not deserialize it",
    detail:
      "Untrusted bytes are being turned back into objects by a format that can construct arbitrary types, which is enough to run code. Use a data-only format such as JSON, and validate the result against a schema before using it.",
  },
  "restrict-outbound-requests": {
    short: "Restrict where it can call",
    detail:
      "The server fetches a URL the caller supplies, so it can be pointed at your internal network or a cloud metadata endpoint. Allow only the hosts you meant, resolve the name and check the address is not private, and do not follow redirects blindly.",
  },
  "guard-prototype-keys": {
    short: "Guard the object keys",
    detail:
      "A merge or assignment copies keys from untrusted input, so a key called __proto__ or constructor can change behaviour for every object in the process. Reject those keys explicitly, or build the target with a null prototype.",
  },
};

/**
 * A key with no entry falls back to the slug rather than to silence.
 *
 * Showing the raw key is ugly and obviously wrong, which is the point: a
 * missing entry should be visible rather than quietly reading as advice.
 */
export function remediationLabel(key: string): Remediation {
  const known = REMEDIATIONS[key];
  if (known !== undefined) return known;
  return {
    short: key.replaceAll("-", " "),
    detail: "No guidance is written for this one yet.",
  };
}

/** Every key this table answers, for the guard test. */
export const REMEDIATION_KEYS: readonly string[] = Object.keys(REMEDIATIONS);
