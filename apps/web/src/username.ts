/**
 * What is wrong with a username, in words.
 *
 * The field used to lean entirely on `pattern` plus `reportValidity()`, which
 * says "Please match the format requested." over a field whose format was
 * described nowhere, in a bubble that disappears and cannot be read again. And
 * `maxlength` silently clipped a longer paste to 39 characters and scanned a
 * name nobody had typed.
 */

/** GitHub's own ceiling. */
export const MAX_USERNAME = 39;

const SHAPE = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/;

export function usernameProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "Enter a GitHub username.";
  if (value.length > MAX_USERNAME) {
    return `A GitHub username is at most ${String(MAX_USERNAME)} characters, and that is ${String(value.length)}.`;
  }
  if (value.startsWith("-") || value.endsWith("-")) {
    return "A GitHub username cannot start or end with a hyphen.";
  }
  if (value.includes("--")) {
    return "A GitHub username cannot contain two hyphens in a row.";
  }
  if (!SHAPE.test(value)) {
    return "A GitHub username is letters, numbers and single hyphens. Nothing else, and no spaces.";
  }
  return null;
}
