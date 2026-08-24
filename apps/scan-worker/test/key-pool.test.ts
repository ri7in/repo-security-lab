import { describe, expect, it } from "vitest";
import { pooledFetch } from "../src/key-pool.js";

function response(status: number): Response {
  return { status } as Response;
}

describe("provider key pool", () => {
  it("rotates to the next key on a rate limit, inside one call", async () => {
    const seen: string[] = [];
    const send = pooledFetch(["key-a", "key-b"], (_input, init) => {
      const auth = (init as { headers: Record<string, string> }).headers[
        "authorization"
      ];
      seen.push(auth ?? "none");
      return Promise.resolve(response(auth === "Bearer key-a" ? 429 : 200));
    });
    const result = await send("https://provider.example", { headers: {} });
    expect(result.status).toBe(200);
    expect(seen).toEqual(["Bearer key-a", "Bearer key-b"]);
  });

  it("remembers which key answered, so a drained account is not tried first forever", async () => {
    let drained = true;
    const seen: string[] = [];
    const send = pooledFetch(["key-a", "key-b"], (_input, init) => {
      const auth = (init as { headers: Record<string, string> }).headers[
        "authorization"
      ];
      seen.push(auth ?? "none");
      return Promise.resolve(
        response(drained && auth === "Bearer key-a" ? 429 : 200),
      );
    });
    await send("https://provider.example", { headers: {} });
    drained = false;
    await send("https://provider.example", { headers: {} });
    // The second call starts on the key that worked, not on the drained one.
    expect(seen).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-b"]);
  });

  it("returns the final 429 when every key is drained", async () => {
    const send = pooledFetch(["key-a", "key-b"], () =>
      Promise.resolve(response(429)),
    );
    const result = await send("https://provider.example", { headers: {} });
    expect(result.status).toBe(429);
  });

  it("passes non-rate-limit failures through without rotating", async () => {
    const seen: string[] = [];
    const send = pooledFetch(["key-a", "key-b"], (_input, init) => {
      seen.push(
        (init as { headers: Record<string, string> }).headers["authorization"] ??
          "none",
      );
      return Promise.resolve(response(500));
    });
    const result = await send("https://provider.example", { headers: {} });
    // A 500 is the provider struggling, not this key being spent; burning
    // the whole pool on it would spend every account on one outage.
    expect(result.status).toBe(500);
    expect(seen).toEqual(["Bearer key-a"]);
  });

  it("keeps a single key working as a pool of one", async () => {
    const send = pooledFetch(["only-key"], () => Promise.resolve(response(200)));
    expect((await send("https://provider.example", { headers: {} })).status).toBe(200);
  });
});
