import { z } from "zod";
import {
  commitShaSchema,
  githubLoginSchema,
  githubRepoNameSchema,
  type GithubLogin,
} from "@app/contracts";
import type { DiscoveredRepository } from "@app/core";
import { GithubClientError } from "./errors.js";

const DEFAULT_GRAPHQL_URL = "https://api.github.com/graphql";
const DEFAULT_REST_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_PAGES = 1_000;
const MAX_JSON_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const strictJsonDecoder = new TextDecoder("utf-8", { fatal: true });

function reportGithubFailure(
  stage: string,
  details: Readonly<Record<string, string | number>>,
): void {
  console.error(
    JSON.stringify({ event: "github_discovery_failure", stage, ...details }),
  );
}

const safeGithubIdSchema = z.number().int().nonnegative().safe();

const graphRepositorySchema = z.object({
  databaseId: safeGithubIdSchema,
  name: githubRepoNameSchema,
  isFork: z.boolean(),
  pushedAt: z.string().max(64).nullish(),
  defaultBranchRef: z
    .object({
      target: z.object({
        __typename: z.literal("Commit"),
        oid: commitShaSchema,
      }),
    })
    .nullable(),
});

const graphResponseSchema = z.object({
  data: z
    .object({
      user: z
        .object({
          databaseId: safeGithubIdSchema,
          login: githubLoginSchema,
          repositories: z.object({
            totalCount: safeGithubIdSchema,
            pageInfo: z.object({
              hasNextPage: z.boolean(),
              endCursor: z.string().max(2_048).nullable(),
            }),
            nodes: z.array(graphRepositorySchema.nullable()).max(100),
          }),
        })
        .nullable(),
    })
    .optional(),
  errors: z
    .array(z.object({ type: z.string().max(64).optional() }))
    .optional(),
});

const restUserSchema = z.object({
  id: safeGithubIdSchema,
  login: githubLoginSchema,
  type: z.string().max(32),
  public_repos: safeGithubIdSchema,
});

const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes(" ") &&
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      }),
    { message: "invalid branch name" },
  );

const restRepositorySchema = z.object({
  id: safeGithubIdSchema,
  name: githubRepoNameSchema,
  fork: z.boolean(),
  default_branch: branchNameSchema.nullable(),
  owner: z.object({ id: safeGithubIdSchema }),
  pushed_at: z.string().max(64).nullish(),
});

/**
 * GitHub's push timestamp as epoch milliseconds, or null.
 *
 * Null rather than a throw on anything unparseable: the timestamp only ranks
 * repositories for deep-read slots, and a scan must never fail over a
 * malformed date when every security-relevant field validated.
 */
function pushedAtMsFrom(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const parsed = Date.parse(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

const restCommitSchema = z.object({ sha: commitShaSchema });

export interface DiscoveredAccount {
  readonly githubAccountId: number;
  readonly canonicalLogin: GithubLogin;
  readonly repositories: readonly (DiscoveredRepository & {
    readonly isFork: boolean;
  })[];
}

export interface DiscoveryResult {
  readonly mode: "authenticated_graphql" | "unauthenticated_rest";
  readonly requestCount: number;
  readonly account: DiscoveredAccount;
}

export interface GithubDiscoveryClientOptions {
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  readonly graphqlUrl?: string;
  readonly restBaseUrl?: string;
  readonly requestTimeoutMs?: number;
}

interface JsonResponse {
  readonly body: unknown;
  readonly headers: Headers;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new GithubClientError("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GithubClientError("INVALID_RESPONSE");
      }
      chunks.push(result.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new GithubClientError("INVALID_RESPONSE");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validatedHttpsEndpoint(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid ${label} URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`invalid ${label} URL`);
  }
  return url;
}

const DISCOVERY_QUERY = `query AccountRepositories($login: String!, $cursor: String) {
  user(login: $login) {
    databaseId
    login
    repositories(
      first: 100
      after: $cursor
      privacy: PUBLIC
      ownerAffiliations: OWNER
      orderBy: { field: NAME, direction: ASC }
    ) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        databaseId
        name
        isFork
        pushedAt
        defaultBranchRef { target { __typename ... on Commit { oid } } }
      }
    }
  }
}`;

export class GithubDiscoveryClient {
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #graphqlUrl: string;
  readonly #restBaseUrl: string;
  readonly #requestTimeoutMs: number;

  constructor(options: GithubDiscoveryClientOptions = {}) {
    this.#token =
      options.token === undefined || options.token.length === 0
        ? undefined
        : options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#graphqlUrl = validatedHttpsEndpoint(
      options.graphqlUrl ?? DEFAULT_GRAPHQL_URL,
      "GitHub GraphQL",
    ).href.replace(/\/$/, "");
    this.#restBaseUrl = validatedHttpsEndpoint(
      options.restBaseUrl ?? DEFAULT_REST_URL,
      "GitHub REST base",
    ).href.replace(/\/$/, "");
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

  async discover(username: string): Promise<DiscoveryResult> {
    const parsedUsername = githubLoginSchema.safeParse(username);
    if (!parsedUsername.success) {
      throw new GithubClientError("INVALID_USERNAME");
    }
    return this.#token === undefined
      ? this.#discoverRest(parsedUsername.data)
      : this.#discoverGraphql(parsedUsername.data);
  }

  async #discoverGraphql(username: GithubLogin): Promise<DiscoveryResult> {
    const repositories: Array<DiscoveredRepository & { isFork: boolean }> = [];
    let accountId: number | null = null;
    let canonicalLogin: GithubLogin | null = null;
    let cursor: string | null = null;
    let requestCount = 0;
    let expectedTotalCount: number | null = null;
    const seenCursors = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      requestCount += 1;
      const response = await this.#requestJson(
        this.#graphqlUrl,
        {
          method: "POST",
          headers: this.#headers(true),
          body: JSON.stringify({
            query: DISCOVERY_QUERY,
            variables: { login: username, cursor },
          }),
        },
        true,
      );
      const parsed = graphResponseSchema.safeParse(response.body);
      if (!parsed.success) {
        reportGithubFailure("graphql_schema", {
          issueCode: parsed.error.issues[0]?.code ?? "unknown",
          issuePath: parsed.error.issues[0]?.path.join(".") ?? "unknown",
        });
        throw new GithubClientError("INVALID_RESPONSE");
      }
      if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
        if (parsed.data.errors.some((error) => error.type === "RATE_LIMITED")) {
          throw new GithubClientError(
            "RATE_LIMITED",
            this.#retryAfterSeconds(response.headers),
          );
        }
        // GitHub answers a login that is not a user account, whether it does
        // not exist or belongs to an organisation, with data.user null AND a
        // NOT_FOUND entry here. The null branch below was therefore never
        // reached, and every one of those lookups came back to the visitor as
        // "the download failed part way through, running the scan again
        // usually works", which can never work.
        if (parsed.data.errors.some((error) => error.type === "NOT_FOUND")) {
          throw new GithubClientError("ACCOUNT_NOT_FOUND");
        }
        reportGithubFailure("graphql_errors", {
          errorType: parsed.data.errors[0]?.type ?? "unknown",
        });
        throw new GithubClientError("INVALID_RESPONSE");
      }
      if (parsed.data.data === undefined) {
        throw new GithubClientError("INVALID_RESPONSE");
      }
      const user = parsed.data.data.user;
      if (user === null) {
        throw new GithubClientError("ACCOUNT_NOT_FOUND");
      }
      if (accountId !== null && accountId !== user.databaseId) {
        throw new GithubClientError("INVALID_RESPONSE");
      }
      if (canonicalLogin !== null && canonicalLogin !== user.login) {
        throw new GithubClientError("INVALID_RESPONSE");
      }
      accountId = user.databaseId;
      canonicalLogin = user.login;
      if (
        expectedTotalCount !== null &&
        expectedTotalCount !== user.repositories.totalCount
      ) {
        throw new GithubClientError("REPOSITORY_CHANGED");
      }
      expectedTotalCount = user.repositories.totalCount;

      for (const repository of user.repositories.nodes) {
        if (repository === null) {
          throw new GithubClientError("INVALID_RESPONSE");
        }
        repositories.push({
          repositoryId: repository.databaseId,
          name: repository.name,
          commitSha: repository.defaultBranchRef?.target.oid ?? null,
          isFork: repository.isFork,
          pushedAtMs: pushedAtMsFrom(repository.pushedAt),
        });
      }

      if (!user.repositories.pageInfo.hasNextPage) {
        if (
          accountId === null ||
          canonicalLogin === null ||
          expectedTotalCount === null ||
          repositories.length !== expectedTotalCount
        ) {
          if (repositories.length !== expectedTotalCount) {
            throw new GithubClientError("REPOSITORY_CHANGED");
          }
          throw new GithubClientError("INVALID_RESPONSE");
        }
        return {
          mode: "authenticated_graphql",
          requestCount,
          account: this.#finishAccount(
            accountId,
            canonicalLogin,
            repositories,
          ),
        };
      }
      cursor = user.repositories.pageInfo.endCursor;
      if (cursor === null) {
        throw new GithubClientError("INVALID_RESPONSE");
      }
      if (seenCursors.has(cursor)) {
        throw new GithubClientError("REPOSITORY_CHANGED");
      }
      seenCursors.add(cursor);
    }
    throw new GithubClientError("UPSTREAM_FAILED");
  }

  async #discoverRest(username: GithubLogin): Promise<DiscoveryResult> {
    let requestCount = 0;
    requestCount += 1;
    const userResponse = await this.#requestJson(
      `${this.#restBaseUrl}/users/${encodeURIComponent(username)}`,
      { headers: this.#headers(false) },
      false,
    );
    const user = restUserSchema.safeParse(userResponse.body);
    if (!user.success) {
      throw new GithubClientError("INVALID_RESPONSE");
    }
    if (user.data.type !== "User") {
      throw new GithubClientError("ACCOUNT_NOT_PERSONAL");
    }

    const repositories: Array<DiscoveredRepository & { isFork: boolean }> = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      requestCount += 1;
      const pageResponse = await this.#requestJson(
        `${this.#restBaseUrl}/users/${encodeURIComponent(
          user.data.login,
        )}/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=${page}`,
        { headers: this.#headers(false) },
        false,
      );
      const parsedPage = z
        .array(restRepositorySchema)
        .max(100)
        .safeParse(pageResponse.body);
      if (!parsedPage.success) {
        throw new GithubClientError("INVALID_RESPONSE");
      }
      for (const repository of parsedPage.data) {
        if (repository.owner.id !== user.data.id) {
          throw new GithubClientError("INVALID_RESPONSE");
        }
        let commitSha: string | null = null;
        if (repository.default_branch !== null) {
          try {
            requestCount += 1;
            const commitResponse = await this.#requestJson(
              `${this.#restBaseUrl}/repos/${encodeURIComponent(
                user.data.login,
              )}/${encodeURIComponent(repository.name)}/commits/${encodeURIComponent(
                repository.default_branch,
              )}`,
              { headers: this.#headers(false) },
              false,
              true,
            );
            const commit = restCommitSchema.safeParse(commitResponse.body);
            if (!commit.success) {
              throw new GithubClientError("INVALID_RESPONSE");
            }
            commitSha = commit.data.sha;
          } catch (error) {
            if (
              error instanceof GithubClientError &&
              error.code === "EMPTY_REPOSITORY"
            ) {
              commitSha = null;
            } else {
              throw error;
            }
          }
        }
        repositories.push({
          repositoryId: repository.id,
          name: repository.name,
          commitSha,
          isFork: repository.fork,
          pushedAtMs: pushedAtMsFrom(repository.pushed_at),
        });
      }
      if (parsedPage.data.length < 100) {
        if (repositories.length !== user.data.public_repos) {
          throw new GithubClientError("REPOSITORY_CHANGED");
        }
        return {
          mode: "unauthenticated_rest",
          requestCount,
          account: this.#finishAccount(
            user.data.id,
            user.data.login,
            repositories,
          ),
        };
      }
    }
    throw new GithubClientError("UPSTREAM_FAILED");
  }

  #headers(graphql: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "repository-security-worker",
      "X-GitHub-Api-Version": API_VERSION,
    };
    if (graphql) {
      headers["Content-Type"] = "application/json";
    }
    if (this.#token !== undefined) {
      headers["Authorization"] = `Bearer ${this.#token}`;
    }
    return headers;
  }

  async #requestJson(
    url: string,
    init: RequestInit,
    requiresAuth: boolean,
    commitLookup = false,
  ): Promise<JsonResponse> {
    if (requiresAuth && this.#token === undefined) {
      throw new GithubClientError("AUTH_REQUIRED");
    }
    let response: Response;
    try {
      const fetchImpl = this.#fetch;
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (error) {
      reportGithubFailure("fetch", {
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : "unknown",
      });
      throw new GithubClientError("NETWORK_FAILED");
    }
    if (response.status === 401) {
      await cancelBody(response);
      throw new GithubClientError("AUTH_REQUIRED");
    }
    if (commitLookup && response.status === 409) {
      await cancelBody(response);
      throw new GithubClientError("EMPTY_REPOSITORY");
    }
    if (response.status === 404) {
      await cancelBody(response);
      throw new GithubClientError(
        commitLookup ? "REPOSITORY_CHANGED" : "ACCOUNT_NOT_FOUND",
      );
    }
    if (
      response.status === 429 ||
      (response.status === 403 && this.#isRateLimitResponse(response.headers))
    ) {
      await cancelBody(response);
      throw new GithubClientError(
        "RATE_LIMITED",
        this.#retryAfterSeconds(response.headers),
      );
    }
    if (!response.ok) {
      reportGithubFailure("http", { status: response.status });
      await cancelBody(response);
      throw new GithubClientError("UPSTREAM_FAILED");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (
        !/^\d+$/.test(contentLength) ||
        !Number.isSafeInteger(parsedLength) ||
        parsedLength > MAX_JSON_BYTES
      ) {
        await cancelBody(response);
        throw new GithubClientError("INVALID_RESPONSE");
      }
    }
    try {
      const bytes = await readBoundedBody(response);
      return {
        body: JSON.parse(strictJsonDecoder.decode(bytes)) as unknown,
        headers: response.headers,
      };
    } catch (error) {
      reportGithubFailure("json", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      throw new GithubClientError("INVALID_RESPONSE");
    }
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
        Math.max(0, Number(reset) - Math.floor(Date.now() / 1_000)),
        86_400,
      );
    }
    return null;
  }

  #finishAccount(
    githubAccountId: number,
    canonicalLogin: GithubLogin,
    repositories: Array<DiscoveredRepository & { isFork: boolean }>,
  ): DiscoveredAccount {
    const seen = new Set<number>();
    for (const repository of repositories) {
      if (seen.has(repository.repositoryId)) {
        throw new GithubClientError("INVALID_RESPONSE");
      }
      seen.add(repository.repositoryId);
    }
    return {
      githubAccountId,
      canonicalLogin,
      repositories: repositories.toSorted(
        (left, right) => left.repositoryId - right.repositoryId,
      ),
    };
  }
}
