import { describe, expect, it, vi } from "vitest";
import {
  OpenRouterScout,
  type FetchLike,
} from "../src/index.js";

function jsonFetch(content: unknown, status = 200): FetchLike {
  const body = JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
  });
  return vi.fn(() =>
    Promise.resolve({
      ok: status < 400,
      status,
      text: () => Promise.resolve(body),
    }),
  );
}

describe("providers", () => {
  it("sends the data-collection policy on every request", async () => {
    const fetchMock = jsonFetch({ flags: [] });
    await new OpenRouterScout({
      apiKey: "k",
      model: "qwen/qwen3-coder:free",
      fetch: fetchMock,
      dataPolicy: { allowTrainingProviders: false },
    }).analyze({ systemPrompt: "s", userPrompt: "u" });
    const body = JSON.parse(
      (fetchMock as unknown as { mock: { calls: [string, { body: string }][] } })
        .mock.calls[0]![1].body,
    ) as { provider: { data_collection: string } };
    expect(body.provider.data_collection).toBe("deny");
  });

  it("recovers JSON a model wrapped in prose", async () => {
    const fetchMock: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              choices: [
                { message: { content: 'Sure!\n```json\n{"flags":[]}\n```\nDone.' } },
              ],
            }),
          ),
      });
    await expect(
      new OpenRouterScout({
        apiKey: "k",
        model: "m",
        fetch: fetchMock,
        dataPolicy: { allowTrainingProviders: true },
      }).analyze({ systemPrompt: "s", userPrompt: "u" }),
    ).resolves.toEqual({ flags: [] });
  });

  it("separates a rate limit from a broken response", async () => {
    const limited = new OpenRouterScout({
      apiKey: "k",
      model: "m",
      fetch: jsonFetch({}, 429),
      dataPolicy: { allowTrainingProviders: true },
    });
    await expect(
      limited.analyze({ systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("refuses to construct without a key", () => {
    expect(
      () =>
        new OpenRouterScout({
          apiKey: "  ",
          model: "m",
          fetch: jsonFetch({}),
          dataPolicy: { allowTrainingProviders: true },
        }),
    ).toThrow(/API key/);
  });
});


/**
 * The adapter is the only place untrusted model output becomes typed data, so
 * every way it can be wrong matters more than the happy path. "The reader
 * found nothing" and "the reader broke" must never look the same to the
 * coverage ledger.
 */

function rawFetch(body: string, status = 200): FetchLike {
  return vi.fn(() =>
    Promise.resolve({
      ok: status < 400,
      status,
      text: () => Promise.resolve(body),
    }),
  );
}

function scout(fetchLike: FetchLike): OpenRouterScout {
  return new OpenRouterScout({
    apiKey: "k",
    model: "stealth/ox-alpha",
    fetch: fetchLike,
    dataPolicy: { allowTrainingProviders: true },
  });
}

async function kindOf(fetchLike: FetchLike): Promise<string> {
  try {
    await scout(fetchLike).analyze({ systemPrompt: "s", userPrompt: "u" });
    return "no error";
  } catch (error) {
    return (error as { kind?: string }).kind ?? "unknown";
  }
}

describe("classifying what a provider did", () => {
  it("separates a refused key from a rate limit from an outage", async () => {
    // The funnel reports the kind, so a key that was revoked must not be
    // reported as the provider being busy.
    expect(await kindOf(rawFetch("{}", 401))).toBe("unauthorized");
    expect(await kindOf(rawFetch("{}", 403))).toBe("unauthorized");
    expect(await kindOf(rawFetch("{}", 429))).toBe("rate_limited");
    expect(await kindOf(rawFetch("{}", 500))).toBe("server");
    expect(await kindOf(rawFetch("{}", 503))).toBe("server");
  });

  it("calls every shape of unusable body malformed, never empty", async () => {
    for (const body of [
      "not json at all",
      "{}",
      '{"choices":[]}',
      '{"choices":[{}]}',
      '{"choices":[{"message":{}}]}',
      '{"choices":[{"message":{"content":42}}]}',
      '{"choices":[{"message":{"content":"no object here"}}]}',
      '{"choices":[{"message":{"content":"} backwards {"}}]}',
    ]) {
      expect(await kindOf(rawFetch(body)), body).toBe("malformed");
    }
  });

  it("recovers a model that pasted unescaped code into a JSON string", async () => {
    // Models routinely do this, and it is invalid JSON for one specific and
    // repairable reason. Without the repair the whole reader pass is lost.
    const flag = {
      fileToken: 0,
      lineStart: 1,
      lineEnd: 2,
      evidenceQuote: "const q = `SELECT * FROM users WHERE id = ${id}`",
      cwe: "CWE-89",
      impact: "data-disclosure",
      rationale: "PLACEHOLDER",
      confidence: "high",
    };
    const content = JSON.stringify({ flags: [flag] }).replace(
      "PLACEHOLDER",
      // A raw newline and a raw tab inside a JSON string literal. Not in the
      // evidence quote: that field refuses control characters outright,
      // because a quote the grounding gate must match verbatim is one line.
      "line one\nline two\ttabbed",
    );
    const body = JSON.stringify({ choices: [{ message: { content } }] });
    const result = await scout(rawFetch(body)).analyze({
      systemPrompt: "s",
      userPrompt: "u",
    });
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]?.rationale).toContain("line two");
  });

  it("does not repair a control character outside a string", async () => {
    // Escaping everything would let genuinely broken output through.
    const body = JSON.stringify({
      choices: [{ message: { content: '{"flags": [ , ] }' } }],
    });
    expect(await kindOf(rawFetch(body))).toBe("malformed");
  });

  it("takes the first balanced object when a model wraps it in prose", async () => {
    const content = 'Sure! Here you go:\n```json\n{"flags":[]}\n```\nHope that helps.';
    const body = JSON.stringify({ choices: [{ message: { content } }] });
    const result = await scout(rawFetch(body)).analyze({
      systemPrompt: "s",
      userPrompt: "u",
    });
    expect(result.flags).toEqual([]);
  });

  it("refuses a response the contract does not accept", async () => {
    // A shape that parses as JSON but is not a scout response.
    const body = JSON.stringify({
      choices: [{ message: { content: '{"flags":"lots"}' } }],
    });
    expect(await kindOf(rawFetch(body))).not.toBe("no error");
  });
});
