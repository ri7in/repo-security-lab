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
  tagline: "One clear security report for every public repository you own.",
  /** Longer description for README/package metadata surfaces. */
  description:
    "Zero-cost, privacy-preserving security reports covering all public repositories of a GitHub account. Deterministic findings are immutable evidence; target code is never executed.",
  /** Canonical repository URL (private during development). */
  repoUrl: "https://github.com/ri7in/repo-security-lab",
  /** True until Rivin selects the final name (D-020). */
  isPlaceholderName: true,
} as const;

export type Branding = typeof branding;
