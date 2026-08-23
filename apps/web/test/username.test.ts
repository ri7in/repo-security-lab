import { describe, expect, it } from "vitest";
import { MAX_USERNAME, usernameProblem } from "../src/username.js";

/**
 * The field used to lean on `pattern` plus `reportValidity()`, which says
 * "Please match the format requested." over a format described nowhere, and on
 * `maxlength`, which silently clipped a longer paste and scanned a name nobody
 * had typed.
 */

describe("what is wrong with a username", () => {
  it("accepts the names GitHub accepts", () => {
    for (const value of ["ri7in", "octocat", "a", "a-b", "Node-JS-9", "a".repeat(39)]) {
      expect(usernameProblem(value), value).toBeNull();
    }
  });

  it("ignores surrounding whitespace rather than rejecting it", () => {
    expect(usernameProblem("  ri7in  ")).toBeNull();
  });

  it("says a long paste is too long instead of quietly shortening it", () => {
    const problem = usernameProblem("a".repeat(45));
    expect(problem).toContain("39");
    expect(problem).toContain("45");
  });

  it("names the specific thing that is wrong, not the format in general", () => {
    expect(usernameProblem("-nope")).toContain("start or end with a hyphen");
    expect(usernameProblem("nope-")).toContain("start or end with a hyphen");
    expect(usernameProblem("no--pe")).toContain("two hyphens in a row");
    expect(usernameProblem("has space")).toContain("no spaces");
  });

  it("asks for one when the field is empty", () => {
    expect(usernameProblem("")).toBe("Enter a GitHub username.");
    expect(usernameProblem("   ")).toBe("Enter a GitHub username.");
  });

  it("refuses anything that is not a username at all", () => {
    for (const value of [
      "../../etc/passwd",
      "<script>alert(1)</script>",
      "user@example.com",
      "user/repo",
      "ünïcode",
      "a b",
      "%2e%2e",
    ]) {
      expect(usernameProblem(value), value).not.toBeNull();
    }
  });

  it("holds GitHub's own ceiling in one place", () => {
    expect(MAX_USERNAME).toBe(39);
    expect(usernameProblem("a".repeat(MAX_USERNAME))).toBeNull();
    expect(usernameProblem("a".repeat(MAX_USERNAME + 1))).not.toBeNull();
  });
});
