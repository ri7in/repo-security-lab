/* eslint-disable @typescript-eslint/require-await -- fetch doubles implement the asynchronous Fetch contract */
import { describe, expect, it } from "vitest";
import {
  GithubClientError,
  GithubDiscoveryClient,
} from "@app/github";

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function bodyText(body: RequestInit["body"]): string {
  if (typeof body !== "string") throw new Error("test expected string body");
  return body;
}

function graphqlPage(
  nodes: unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
  totalCount = nodes.length,
) {
  return {
    data: {
      user: {
        databaseId: 123,
        login: "ri7in",
        repositories: {
          totalCount,
          pageInfo: { hasNextPage, endCursor },
          nodes,
        },
      },
    },
  };
}

describe("authenticated GraphQL discovery", () => {
  it("paginates every owned public repository, including forks and empty repos", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      graphqlPage(
        [
          {
            databaseId: 20,
            name: "forked-tool",
            isFork: true,
            pushedAt: "2026-08-20T10:00:00Z",
            defaultBranchRef: {
              target: { __typename: "Commit", oid: "b".repeat(40) },
            },
          },
          {
            databaseId: 30,
            name: "empty-repo",
            isFork: false,
            pushedAt: null,
            defaultBranchRef: null,
          },
        ],
        true,
        "cursor-1",
        3,
      ),
      graphqlPage(
        [
          {
            databaseId: 10,
            name: "main-tool",
            isFork: false,
            defaultBranchRef: {
              target: { __typename: "Commit", oid: "a".repeat(40) },
            },
          },
        ],
        false,
        null,
        3,
      ),
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: requestUrl(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected test request");
      return jsonResponse(response);
    };

    const result = await new GithubDiscoveryClient({
      token: "synthetic-test-token",
      fetchImpl,
      graphqlUrl: "https://github.test/graphql",
    }).discover("ri7in");

    expect(result.mode).toBe("authenticated_graphql");
    expect(result.requestCount).toBe(2);
    expect(result.account.githubAccountId).toBe(123);
    expect(result.account.repositories.map((repo) => repo.repositoryId)).toEqual([
      10, 20, 30,
    ]);
    expect(result.account.repositories[1]?.isFork).toBe(true);
    expect(result.account.repositories[2]?.commitSha).toBeNull();
    // The push time feeds the deep-read slot ranking: an ISO date maps to
    // epoch milliseconds, an explicit null and an omitted field both map to
    // null rather than failing the whole discovery.
    expect(result.account.repositories[1]?.pushedAtMs).toBe(
      Date.parse("2026-08-20T10:00:00Z"),
    );
    expect(result.account.repositories[2]?.pushedAtMs).toBeNull();
    expect(result.account.repositories[0]?.pushedAtMs).toBeNull();
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer synthetic-test-token",
    );
    const secondBody = JSON.parse(bodyText(calls[1]?.init?.body)) as {
      variables: { cursor: string };
      query: string;
    };
    expect(secondBody.variables.cursor).toBe("cursor-1");
    expect(secondBody.query).toContain("ownerAffiliations: OWNER");
    expect(secondBody.query).toContain("privacy: PUBLIC");
    expect(secondBody.query).toContain("totalCount");
  });

  it("rejects partial GraphQL errors rather than silently omitting repositories", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        ...graphqlPage([], false, null),
        errors: [{ message: "target-controlled upstream prose is ignored" }],
      });
    await expect(
      new GithubDiscoveryClient({ token: "test", fetchImpl }).discover("ri7in"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("calls a login that is not a user account not found, not a network fault", async () => {
    // GitHub answers a login that is not a user, whether it does not exist or
    // belongs to an organisation, with data.user null AND a NOT_FOUND entry in
    // errors. The errors branch ran first and threw INVALID_RESPONSE, which
    // the API maps to a network failure, so a typo was told "the download
    // failed part way through, running the scan again usually works".
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: { user: null },
        errors: [
          {
            type: "NOT_FOUND",
            message: "Could not resolve to a User with the login of 'nodejs'.",
          },
        ],
      });
    await expect(
      new GithubDiscoveryClient({ token: "test", fetchImpl }).discover("nodejs"),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("still calls an unrecognised GraphQL error a broken response", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        ...graphqlPage([], false, null),
        errors: [{ type: "SOMETHING_ELSE", message: "ignored prose" }],
      });
    await expect(
      new GithubDiscoveryClient({ token: "test", fetchImpl }).discover("ri7in"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects duplicate repository ids across pages", async () => {
    const node = {
      databaseId: 10,
      name: "same",
      isFork: false,
      defaultBranchRef: null,
    };
    const responses = [
      graphqlPage([node], true, "next", 2),
      graphqlPage([node], false, null, 2),
    ];
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(responses.shift());
    await expect(
      new GithubDiscoveryClient({ token: "test", fetchImpl }).discover("ri7in"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("maps GitHub's HTTP-200 GraphQL rate error to a fixed retryable failure", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        { errors: [{ type: "RATE_LIMITED", message: "ignored" }] },
        200,
        { "retry-after": "45" },
      );
    await expect(
      new GithubDiscoveryClient({ token: "test", fetchImpl }).discover("ri7in"),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 45,
      message: "RATE_LIMITED",
    });
  });

  it("detects a repository-set change instead of returning an incomplete page set", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(graphqlPage([], false, null, 1));
    await expect(
      new GithubDiscoveryClient({ token: "test", fetchImpl }).discover("ri7in"),
    ).rejects.toMatchObject({ code: "REPOSITORY_CHANGED" });
  });
});

describe("REST fallback discovery", () => {
  it("resolves immutable commit ids and keeps forks", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.endsWith("/users/ri7in")) {
        return jsonResponse({
          id: 123,
          login: "ri7in",
          type: "User",
          public_repos: 2,
        });
      }
      if (url.includes("/users/ri7in/repos?")) {
        return jsonResponse([
          {
            id: 20,
            name: "forked-tool",
            fork: true,
            default_branch: "main",
            owner: { id: 123 },
            pushed_at: "2026-08-19T09:30:00Z",
          },
          {
            id: 30,
            name: "empty-repo",
            fork: false,
            default_branch: null,
            owner: { id: 123 },
            pushed_at: "not-a-date",
          },
        ]);
      }
      if (url.endsWith("/repos/ri7in/forked-tool/commits/main")) {
        return jsonResponse({ sha: "c".repeat(40) });
      }
      throw new Error("unexpected test request");
    };

    const result = await new GithubDiscoveryClient({
      fetchImpl,
      restBaseUrl: "https://github.test",
    }).discover("ri7in");
    expect(result.mode).toBe("unauthenticated_rest");
    expect(result.requestCount).toBe(3);
    expect(result.account.repositories[0]).toMatchObject({
      repositoryId: 20,
      isFork: true,
      commitSha: "c".repeat(40),
    });
    expect(result.account.repositories[1]?.commitSha).toBeNull();
    expect(result.account.repositories[0]?.pushedAtMs).toBe(
      Date.parse("2026-08-19T09:30:00Z"),
    );
    // A malformed date only ranks the repository last; it never fails a scan.
    expect(result.account.repositories[1]?.pushedAtMs).toBeNull();
    expect(requests).toHaveLength(3);
  });

  it("treats only GitHub's empty-repository 409 as no default-branch oid", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/users/ri7in")) {
        return jsonResponse({
          id: 123,
          login: "ri7in",
          type: "User",
          public_repos: 1,
        });
      }
      if (url.includes("/users/ri7in/repos?")) {
        return jsonResponse([
          {
            id: 1,
            name: "new-repo",
            fork: false,
            default_branch: "main",
            owner: { id: 123 },
          },
        ]);
      }
      return jsonResponse({}, 409);
    };
    const result = await new GithubDiscoveryClient({
      fetchImpl,
      restBaseUrl: "https://github.test",
    }).discover("ri7in");
    expect(result.account.repositories[0]?.commitSha).toBeNull();
    expect(result.requestCount).toBe(3);
  });

  it("refuses organization accounts in the personal-user slice", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        id: 123,
        login: "ri7in",
        type: "Organization",
        public_repos: 0,
      });
    await expect(
      new GithubDiscoveryClient({ fetchImpl }).discover("ri7in"),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_PERSONAL" });
  });

  it("cross-checks the account repository count before accepting the result", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = requestUrl(input);
      return url.endsWith("/users/ri7in")
        ? jsonResponse({
            id: 123,
            login: "ri7in",
            type: "User",
            public_repos: 1,
          })
        : jsonResponse([]);
    };
    await expect(
      new GithubDiscoveryClient({
        fetchImpl,
        restBaseUrl: "https://github.test",
      }).discover("ri7in"),
    ).rejects.toMatchObject({ code: "REPOSITORY_CHANGED" });
  });
});

describe("fixed failures", () => {
  it("does not rebind the Fetch receiver in standards-strict runtimes", async () => {
    const receivers: unknown[] = [];
    const fetchImpl: typeof fetch = async function (this: unknown, input) {
      receivers.push(this);
      return requestUrl(input).endsWith("/users/ri7in")
        ? jsonResponse({
            id: 123,
            login: "ri7in",
            type: "User",
            public_repos: 0,
          })
        : jsonResponse([]);
    };

    const result = await new GithubDiscoveryClient({ fetchImpl }).discover(
      "ri7in",
    );

    expect(result.account.repositories).toEqual([]);
    expect(receivers).toEqual([undefined, undefined]);
  });

  it("refuses non-HTTPS or credential-bearing configured endpoints", () => {
    for (const options of [
      { graphqlUrl: "http://api.github.test/graphql" },
      { graphqlUrl: "https://token@api.github.test/graphql" },
      { restBaseUrl: "https://api.github.test?redirect=evil" },
    ]) {
      expect(() => new GithubDiscoveryClient(options)).toThrow(/invalid .* URL/);
    }
  });

  it("bounds every upstream request with a fixed timeout", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          reject(new Error("missing timeout signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    await expect(
      new GithubDiscoveryClient({
        fetchImpl,
        requestTimeoutMs: 1,
      }).discover("ri7in"),
    ).rejects.toMatchObject({ code: "NETWORK_FAILED" });
  });

  it("stream-bounds a response even when content-length is absent", async () => {
    let cancelled = false;
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1_024 * 1_024));
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    await expect(
      new GithubDiscoveryClient({ token: "test", fetchImpl }).discover("ri7in"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(cancelled).toBe(true);
  });

  it("rejects an invalid username before network access", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    await expect(
      new GithubDiscoveryClient({ fetchImpl }).discover("../../secret"),
    ).rejects.toMatchObject({ code: "INVALID_USERNAME" });
    expect(called).toBe(false);
  });

  it("preserves numeric retry guidance without reading the response body", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ message: "untrusted body" }, 429, { "retry-after": "120" });
    const promise = new GithubDiscoveryClient({
      token: "test",
      fetchImpl,
    }).discover("ri7in");
    await expect(promise).rejects.toBeInstanceOf(GithubClientError);
    await expect(promise).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 120,
      message: "RATE_LIMITED",
    });
  });

  it("does not misclassify an ordinary forbidden response as rate limiting", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({}, 403);
    await expect(
      new GithubDiscoveryClient({ fetchImpl }).discover("ri7in"),
    ).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
  });
});
