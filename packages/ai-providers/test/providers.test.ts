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

