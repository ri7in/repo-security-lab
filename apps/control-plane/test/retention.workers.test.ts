import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { D1Store } from "@app/store-d1";
import {
  purgeExpiredReports,
  REPORT_RETENTION_MS,
} from "../src/retention.js";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM scan_requests;");
});

describe("public report retention", () => {
  it("purges expired terminal reports but preserves recent and active work", async () => {
    const store = new D1Store(env.DB);
    const nowMs = REPORT_RETENTION_MS + 10_000;
    await store.createRequest({
      requestId: "req_expired00001",
      username: "expired-user",
      nowMs: 1,
    });
    await store.failRequest({
      requestId: "req_expired00001",
      reason: "GITHUB_NOT_FOUND",
      nowMs: 2,
    });
    await store.createRequest({
      requestId: "req_recent000001",
      username: "recent-user",
      nowMs: nowMs - REPORT_RETENTION_MS + 1,
    });
    await store.failRequest({
      requestId: "req_recent000001",
      reason: "GITHUB_NOT_FOUND",
      nowMs: nowMs - REPORT_RETENTION_MS + 2,
    });
    await store.createRequest({
      requestId: "req_active000001",
      username: "active-user",
      nowMs: 1,
    });

    await purgeExpiredReports(env.DB, nowMs);

    expect(await store.getRequest("req_expired00001")).toBeNull();
    expect(await store.getRequest("req_recent000001")).not.toBeNull();
    expect(await store.getRequest("req_active000001")).not.toBeNull();
  });
});
