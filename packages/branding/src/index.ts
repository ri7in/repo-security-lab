/**
 * The single source of product identity.
 *
 * D-067: the product name below is a replaceable placeholder. Rivin owns the
 * final name (D-020). Renaming the product must be mechanical: edit this file,
 * follow the rename runbook in `docs/maintenance.md`, and re-run the branding
 * guard test, which fails the build if the placeholder literal appears
 * anywhere outside this file and the explicitly allowed metadata locations.
 *
 * No other source file, document, or configuration may contain the product
 * name literal. Import from this module instead.
 */
export const branding = {
  /** URL-, package-, and repository-safe identifier. */
  productSlug: "repo-security-lab",
  /** Human-readable product name. */
  productDisplayName: "Repo Security Lab",
  /** One-line product description for headers and metadata. */
  tagline:
    "Leaked credentials and insecure Actions workflows, per repository. Checks that did not run are named, not hidden.",
  /** Longer description for README/package metadata surfaces. */
  description:
    "Zero-cost security reports covering every public repository a GitHub account owns. Target code is never executed, and each report states which checks ran and which did not.",
  /** Canonical repository URL. */
  repoUrl: "https://github.com/ri7in/repo-security-lab",
} as const;

export type Branding = typeof branding;
