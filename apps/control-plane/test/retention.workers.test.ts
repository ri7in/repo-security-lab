import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { D1Store } from "@app/store-d1";
import {
  ACTIVE_REPORT_TIMEOUT_MS,
  expireStaleActiveReport,
  purgeExpiredReports,
  REPORT_RETENTION_MS,
} from "../src/retention.js";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM scan_requests; DELETE FROM write_budget;");
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
    await env.DB.prepare(
      "INSERT INTO write_budget(utc_day, modeled_writes) VALUES ('1970-01-31', 40000)",
    ).run();

    await purgeExpiredReports(env.DB, nowMs);

    expect(await store.getRequest("req_expired00001")).toBeNull();
    expect(await store.getRequest("req_recent000001")).not.toBeNull();
    expect(await store.getRequest("req_active000001")).not.toBeNull();
  });

  it("fails stale active work, invalidates its lease, and scrubs notification PII", async () => {
    const store = new D1Store(env.DB);
    await store.createRequest({
      requestId: "req_staleactive01",
      username: "stale-user",
      nowMs: 1,
    });
    await store.completeDiscovery({
      requestId: "req_staleactive01",
      githubAccountId: 42,
      canonicalLogin: "stale-user",
      repositories: [
        {
          repositoryId: 7,
          name: "stale-repo",
          isFork: false,
          commitSha: "a".repeat(40),
        },
      ],
      nowMs: 2,
    });
    await store.claimNext({
      workerId: "worker_stale001",
      nowMs: 3,
      leaseDurationMs: 10 * 60 * 1_000,
    });
    await env.DB.prepare(
      `INSERT INTO scan_notifications(
         request_id, recipient_hash, recipient_ciphertext, recipient_iv,
         state, attempt_count, next_attempt_at_ms, claimed_at_ms, sent_at_ms,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, 'pending', 0, 1, NULL, NULL, 1, 1)`,
    )
      .bind(
        "req_staleactive01",
        "h".repeat(43),
        "c".repeat(16),
        "i".repeat(16),
      )
      .run();

    const nowMs = ACTIVE_REPORT_TIMEOUT_MS + 10_000;
    await env.DB.prepare(
      "INSERT INTO write_budget(utc_day, modeled_writes) VALUES ('1970-01-02', 40000)",
    ).run();
    await expireStaleActiveReport(env.DB, nowMs);

    expect(await store.getRequest("req_staleactive01")).toMatchObject({
      state: "failed",
      reason: "CANCELLED",
    });
    const repositories = await store.listRepositories({
      requestId: "req_staleactive01",
      afterRepositoryId: null,
      limit: 10,
    });
    expect(repositories.repositories[0]).toMatchObject({
      state: "failed",
      reason: "CANCELLED",
      lease: null,
      coverage: {
        snapshot: "failed",
        archive_guard: "failed",
        gitleaks: "failed",
        osv: "failed",
        zizmor: "failed",
        opengrep: "failed",
      },
    });
    expect(
      await env.DB.prepare(
        `SELECT state, recipient_ciphertext, recipient_iv
         FROM scan_notifications WHERE request_id = ?`,
      )
        .bind("req_staleactive01")
        .first(),
    ).toEqual({ state: "failed", recipient_ciphertext: "", recipient_iv: "" });
  });

  it("does not expire a request while repository work is still making progress", async () => {
    const store = new D1Store(env.DB);
    await store.createRequest({
      requestId: "req_activeprogress1",
      username: "active-progress",
      nowMs: 1,
    });
    await store.completeDiscovery({
      requestId: "req_activeprogress1",
      githubAccountId: 43,
      canonicalLogin: "active-progress",
      repositories: [
        {
          repositoryId: 8,
          name: "active-repo",
          isFork: false,
          commitSha: "b".repeat(40),
        },
      ],
      nowMs: 2,
    });
    const nowMs = ACTIVE_REPORT_TIMEOUT_MS + 10_000;
    const claimed = await store.claimNext({
      workerId: "worker_active001",
      nowMs: nowMs - 1,
      leaseDurationMs: 10 * 60 * 1_000,
    });
    expect(claimed).not.toBeNull();

    await expireStaleActiveReport(env.DB, nowMs);

    expect(await store.getRequest("req_activeprogress1")).toMatchObject({
      state: "scanning",
      reason: null,
    });
  });

  it("does not scrub notification data when the cancellation CAS loses a race", async () => {
    const store = new D1Store(env.DB);
    await store.createRequest({
      requestId: "req_expiryrace001",
      username: "expiry-race",
      nowMs: 1,
    });
    await env.DB.prepare(
      `INSERT INTO scan_notifications(
         request_id, recipient_hash, recipient_ciphertext, recipient_iv,
         state, attempt_count, next_attempt_at_ms, claimed_at_ms, sent_at_ms,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, 'pending', 0, 1, NULL, NULL, 1, 1)`,
    )
      .bind(
        "req_expiryrace001",
        "r".repeat(43),
        "c".repeat(16),
        "i".repeat(16),
      )
      .run();
    await env.DB.prepare(
      `CREATE TRIGGER simulate_recovery_before_expiry
       BEFORE UPDATE OF state, reason ON scan_requests
       WHEN NEW.state = 'failed' AND NEW.reason = 'CANCELLED'
       BEGIN
         UPDATE scan_requests SET updated_at_ms = NEW.updated_at_ms
         WHERE request_id = OLD.request_id;
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    try {
      await expireStaleActiveReport(env.DB, ACTIVE_REPORT_TIMEOUT_MS + 10_000);
    } finally {
      await env.DB.prepare("DROP TRIGGER simulate_recovery_before_expiry").run();
    }

    expect(await store.getRequest("req_expiryrace001")).toMatchObject({
      state: "accepted",
      reason: null,
      updatedAtMs: ACTIVE_REPORT_TIMEOUT_MS + 10_000,
    });
    expect(
      await env.DB.prepare(
        `SELECT state, recipient_ciphertext, recipient_iv
         FROM scan_notifications WHERE request_id = ?`,
      )
        .bind("req_expiryrace001")
        .first(),
    ).toEqual({
      state: "pending",
      recipient_ciphertext: "c".repeat(16),
      recipient_iv: "i".repeat(16),
    });
  });
});
