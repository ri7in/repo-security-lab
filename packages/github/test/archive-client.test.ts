/* eslint-disable @typescript-eslint/require-await -- fetch doubles implement the asynchronous Fetch contract */
import { describe, expect, it } from "vitest";
import {
  GithubArchiveClient,
  MAX_COMPRESSED_ARCHIVE_BYTES,
} from "@app/github";

const SHA = "a".repeat(40);

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function consume(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader();
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) return bytes;
    bytes += result.value.byteLength;
  }
}

describe("immutable GitHub archive client", () => {
  it("bounds archive header requests with a fixed timeout", async () => {
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
      new GithubArchiveClient({
        fetchImpl,
        minimumIntervalMs: 0,
        requestTimeoutMs: 1,
      }).fetchArchive({ owner: "ri7in", repository: "tool", commitSha: SHA }),
    ).rejects.toMatchObject({ code: "NETWORK_FAILED" });
  });

  it("requests the exact commit and strips authorization before codeload", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    let redirectBodyCancelled = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      calls.push({ url, init });
      if (url.startsWith("https://api.github.test/")) {
        return new Response(new ReadableStream({
          cancel() {
            redirectBodyCancelled = true;
          },
        }), {
          status: 302,
          headers: {
            location: `https://codeload.github.com/ri7in/tool/legacy.tar.gz/${SHA}`,
          },
        });
      }
      return new Response(new Uint8Array([0x1f, 0x8b, 0x08]), {
        status: 200,
        headers: { "content-length": "3" },
      });
    };
    const result = await new GithubArchiveClient({
      token: "synthetic-token",
      fetchImpl,
      restBaseUrl: "https://api.github.test",
      minimumIntervalMs: 0,
    }).fetchArchive({ owner: "ri7in", repository: "tool", commitSha: SHA });

    expect(calls[0]?.url).toBe(
      `https://api.github.test/repos/ri7in/tool/tarball/${SHA}`,
    );
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer synthetic-token",
    );
    expect(new Headers(calls[1]?.init?.headers).has("authorization")).toBe(false);
    expect(redirectBodyCancelled).toBe(true);
    expect(result).toMatchObject({ contentLength: 3, requestCount: 2 });
    expect(await consume(result.body)).toBe(3);
  });

  it("rejects redirects outside the exact codeload commit path", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: `https://evil.test/ri7in/tool/tar.gz/${SHA}` },
      });
    await expect(
      new GithubArchiveClient({ fetchImpl, minimumIntervalMs: 0 }).fetchArchive({
        owner: "ri7in",
        repository: "tool",
        commitSha: SHA,
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
  });

  it("rejects an oversized declared body before exposing its stream", async () => {
    let bodyCancelled = false;
    const fetchImpl: typeof fetch = async () =>
      new Response(new ReadableStream({
        cancel() {
          bodyCancelled = true;
        },
      }), {
        headers: {
          "content-length": String(MAX_COMPRESSED_ARCHIVE_BYTES + 1),
        },
      });
    await expect(
      new GithubArchiveClient({ fetchImpl, minimumIntervalMs: 0 }).fetchArchive({
        owner: "ri7in",
        repository: "tool",
        commitSha: SHA,
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_LIMIT" });
    expect(bodyCancelled).toBe(true);
  });

  it("cancels a body carrying an invalid content length", async () => {
    let bodyCancelled = false;
    const fetchImpl: typeof fetch = async () =>
      new Response(new ReadableStream({
        cancel() {
          bodyCancelled = true;
        },
      }), {
        headers: { "content-length": "not-a-number" },
      });
    await expect(
      new GithubArchiveClient({ fetchImpl, minimumIntervalMs: 0 }).fetchArchive({
        owner: "ri7in",
        repository: "tool",
        commitSha: SHA,
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
    expect(bodyCancelled).toBe(true);
  });

  it("enforces the compressed limit while streaming without content-length", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_COMPRESSED_ARCHIVE_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const fetchImpl: typeof fetch = async () => new Response(source);
    const result = await new GithubArchiveClient({
      fetchImpl,
      minimumIntervalMs: 0,
    }).fetchArchive({ owner: "ri7in", repository: "tool", commitSha: SHA });
    await expect(consume(result.body)).rejects.toMatchObject({
      code: "ARCHIVE_LIMIT",
    });
  });

  it("serializes concurrent archive starts at the configured interval", async () => {
    let now = 1_000;
    const delays: number[] = [];
    const fetchImpl: typeof fetch = async () =>
      new Response(new Uint8Array([1]));
    const client = new GithubArchiveClient({
      fetchImpl,
      minimumIntervalMs: 500,
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    });
    await Promise.all([
      client.fetchArchive({ owner: "ri7in", repository: "one", commitSha: SHA }),
      client.fetchArchive({ owner: "ri7in", repository: "two", commitSha: SHA }),
    ]);
    expect(delays).toEqual([500]);
  });
});
