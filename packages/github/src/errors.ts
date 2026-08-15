export const GITHUB_ERROR_CODES = [
  "INVALID_USERNAME",
  "AUTH_REQUIRED",
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_NOT_PERSONAL",
  "RATE_LIMITED",
  "NETWORK_FAILED",
  "UPSTREAM_FAILED",
  "INVALID_RESPONSE",
  "EMPTY_REPOSITORY",
  "REPOSITORY_CHANGED",
  "ARCHIVE_LIMIT",
  "ARCHIVE_INVALID",
] as const;

export type GithubErrorCode = (typeof GITHUB_ERROR_CODES)[number];

/** Fixed, non-echoing error. No URL, response body, or target text is stored. */
export class GithubClientError extends Error {
  readonly code: GithubErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: GithubErrorCode, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = "GithubClientError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
