/**
 * Fetch that carries a pool of provider keys, on operator instruction.
 *
 * Contributed OpenRouter accounts each bring their own daily meter. On a 429
 * the next key is tried in the same call, and the pool remembers which key
 * answered last so a drained account is not retried first on every request.
 * The adapters stay single-key and never learn the pool exists; the
 * authorization header is replaced here. Keys are secrets: nothing in this
 * module may log, throw, or serialise one.
 */

interface PoolInit {
  readonly headers: Record<string, string>;
}

export function pooledFetch(
  apiKeys: readonly string[],
  send: (input: string, init: unknown) => Promise<Response> = (input, init) =>
    fetch(input, init as RequestInit),
): (input: string, init: unknown) => Promise<Response> {
  let preferred = 0;
  return async (input: string, init: unknown): Promise<Response> => {
    const request = init as PoolInit;
    let last: Response | null = null;
    const size = Math.max(1, apiKeys.length);
    for (let offset = 0; offset < size; offset += 1) {
      const index = (preferred + offset) % size;
      const key = apiKeys[index];
      const headers =
        key === undefined
          ? request.headers
          : { ...request.headers, authorization: `Bearer ${key}` };
      const response = await send(input, { ...(init as object), headers });
      if (response.status !== 429) {
        preferred = index;
        return response;
      }
      last = response;
    }
    return last ?? (await send(input, init));
  };
}
