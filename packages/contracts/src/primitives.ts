import { z } from "zod";

/**
 * Bounded machine token: allowlisted charset, bounded length, never free-form
 * prose, never archive/scanner-derived text. Used for rule ids, categories,
 * remediation keys, provider families, and similar closed identifiers whose
 * values are validated against trusted manifests or fixed enumerations by the
 * consuming stage.
 */
export const boundedTokenSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i);
export type BoundedToken = z.infer<typeof boundedTokenSchema>;

/**
 * Opaque identifier issued by the control plane or broker (request ids,
 * finding ids, cursors, owner-detail references). Never derived from
 * repository content.
 */
export const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export type OpaqueId = z.infer<typeof opaqueIdSchema>;

/** Exact 40-hex Git object id of the immutable scanned commit. */
export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export type CommitSha = z.infer<typeof commitShaSchema>;

/**
 * GitHub login grammar: 1-39 characters, alphanumeric or single hyphens, no
 * leading/trailing hyphen. This is requester input validated by the control
 * plane, not archive-derived data.
 */
export const githubLoginSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/);
export type GithubLogin = z.infer<typeof githubLoginSchema>;

/**
 * GitHub repository name grammar. The value shown in reports always comes
 * from the control plane's GitHub discovery record, never from scanner or
 * archive output.
 */
export const githubRepoNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/);
export type GithubRepoName = z.infer<typeof githubRepoNameSchema>;

/** Non-negative integer counter used by totals and identifiers. */
export const nonNegativeIntSchema = z.number().int().nonnegative();
