import {
  commitShaSchema,
  githubLoginSchema,
  githubRepoNameSchema,
  type CommitSha,
  type GithubLogin,
  type GithubRepoName,
} from "@app/contracts";
import { GithubClientError } from "./errors.js";

const DEFAULT_REST_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const CODELOAD_HOST = "codeload.github.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export const MAX_COMPRESSED_ARCHIVE_BYTES = 50 * 1_024 * 1_024;

export interface ArchiveRef {
  readonly owner: GithubLogin;
  readonly repository: GithubRepoName;
  readonly commitSha: CommitSha;
}

export interface ArchiveDownload {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentLength: number | null;
  readonly requestCount: 1 | 2;
}

export interface GithubArchiveClientOptions {
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  readonly restBaseUrl?: string;
  readonly minimumIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly requestTimeoutMs?: number;
}

function fixedHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "repository-security-worker",
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function boundedBody(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        received += result.value.byteLength;
        if (received > MAX_COMPRESSED_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => undefined);
          controller.error(new GithubClientError("ARCHIVE_LIMIT"));
          return;
        }
        controller.enqueue(result.value);
      } catch {
        controller.error(new GithubClientError("NETWORK_FAILED"));
      }
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

export class GithubArchiveClient {
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #restBaseUrl: string;
  readonly #minimumIntervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #requestTimeoutMs: number;
  #nextStartMs = 0;
  #gate: Promise<void> = Promise.resolve();

  constructor(options: GithubArchiveClientOptions = {}) {
    this.#token =
      options.token === undefined || options.token.length === 0
        ? undefined
        : options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    const restBaseUrl = new URL(options.restBaseUrl ?? DEFAULT_REST_URL);
    if (
      restBaseUrl.protocol !== "https:" ||
      restBaseUrl.username !== "" ||
      restBaseUrl.password !== "" ||
      restBaseUrl.search !== "" ||
      restBaseUrl.hash !== ""
    ) {
      throw new Error("invalid GitHub archive base URL");
    }
    this.#restBaseUrl = restBaseUrl.href.replace(/\/$/, "");
    this.#minimumIntervalMs = options.minimumIntervalMs ?? 500;
    if (
      !Number.isSafeInteger(this.#minimumIntervalMs) ||
      this.#minimumIntervalMs < 0 ||
      this.#minimumIntervalMs > 60_000
    ) {
      throw new Error("invalid archive pacing interval");
    }
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > 120_000
    ) {
      throw new Error("invalid GitHub request timeout");
    }
  }

  async fetchArchive(input: ArchiveRef): Promise<ArchiveDownload> {
    const owner = githubLoginSchema.safeParse(input.owner);
    const repository = githubRepoNameSchema.safeParse(input.repository);
    const commitSha = commitShaSchema.safeParse(input.commitSha);
    if (!owner.success || !repository.success || !commitSha.success) {
      throw new GithubClientError("ARCHIVE_INVALID");
    }

    return this.#atPacedStart(async () => {
      const archiveUrl = `${this.#restBaseUrl}/repos/${encodeURIComponent(
        owner.data,
      )}/${encodeURIComponent(repository.data)}/tarball/${commitSha.data}`;
      const first = await this.#fetchResponse(archiveUrl, {
        headers: fixedHeaders(this.#token),
        redirect: "manual",
      });

      let response = first;
      let requestCount: 1 | 2 = 1;
      if (first.status >= 300 && first.status < 400) {
        await first.body?.cancel().catch(() => undefined);
        const location = first.headers.get("location");
        if (location === null) throw new GithubClientError("ARCHIVE_INVALID");
        const redirect = this.#validatedRedirect(
          location,
          owner.data,
          repository.data,
          commitSha.data,
        );
        response = await this.#fetchResponse(redirect.href, {
          headers: fixedHeaders(),
          redirect: "error",
        });
        requestCount = 2;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
      }
      this.#assertSuccessful(response);
      let contentLength: number | null;
      try {
        contentLength = this.#contentLength(response.headers);
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      if (
        contentLength !== null &&
        contentLength > MAX_COMPRESSED_ARCHIVE_BYTES
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new GithubClientError("ARCHIVE_LIMIT");
      }
      if (response.body === null) {
        throw new GithubClientError("ARCHIVE_INVALID");
      }
      return {
        body: boundedBody(response.body),
        contentLength,
        requestCount,
      };
    });
  }

  async #atPacedStart<T>(action: () => Promise<T>): Promise<T> {
    const preceding = this.#gate;
    let release: () => void = () => undefined;
    this.#gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      const delay = Math.max(0, this.#nextStartMs - this.#now());
      if (delay > 0) await this.#sleep(delay);
      this.#nextStartMs = this.#now() + this.#minimumIntervalMs;
      return await action();
    } finally {
      release();
    }
  }

  async #fetchResponse(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch {
      throw new GithubClientError("NETWORK_FAILED");
    }
  }

  #assertSuccessful(response: Response): void {
    if (response.status === 401) {
      throw new GithubClientError("AUTH_REQUIRED");
    }
    if (response.status === 404 || response.status === 410) {
      throw new GithubClientError("REPOSITORY_CHANGED");
    }
    if (
      response.status === 429 ||
      (response.status === 403 && this.#isRateLimitResponse(response.headers))
    ) {
      throw new GithubClientError(
        "RATE_LIMITED",
        this.#retryAfterSeconds(response.headers),
      );
    }
    if (!response.ok) throw new GithubClientError("UPSTREAM_FAILED");
  }

  #validatedRedirect(
    location: string,
    owner: GithubLogin,
    repository: GithubRepoName,
    commitSha: CommitSha,
  ): URL {
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      throw new GithubClientError("ARCHIVE_INVALID");
    }
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    let decodedSegments: string[];
    try {
      decodedSegments = segments.map((segment) => decodeURIComponent(segment));
    } catch {
      throw new GithubClientError("ARCHIVE_INVALID");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== CODELOAD_HOST ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      segments.length !== 4 ||
      decodedSegments[0] !== owner ||
      decodedSegments[1] !== repository ||
      !["legacy.tar.gz", "tar.gz"].includes(decodedSegments[2] ?? "") ||
      decodedSegments[3] !== commitSha
    ) {
      throw new GithubClientError("ARCHIVE_INVALID");
    }
    return url;
  }

  #contentLength(headers: Headers): number | null {
    const value = headers.get("content-length");
    if (value === null) return null;
    if (!/^\d+$/.test(value)) throw new GithubClientError("ARCHIVE_INVALID");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new GithubClientError("ARCHIVE_INVALID");
    }
    return parsed;
  }

  #isRateLimitResponse(headers: Headers): boolean {
    return (
      headers.has("retry-after") ||
      headers.get("x-ratelimit-remaining") === "0"
    );
  }

  #retryAfterSeconds(headers: Headers): number | null {
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
      return Math.min(Number(retryAfter), 86_400);
    }
    const reset = headers.get("x-ratelimit-reset");
    if (reset !== null && /^\d+$/.test(reset)) {
      return Math.min(
        Math.max(0, Number(reset) - Math.floor(this.#now() / 1_000)),
        86_400,
      );
    }
    return null;
  }
}
