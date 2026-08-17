import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { D1Store } from "@app/store-d1";
import {
  deliverOneNotification,
  notificationConfiguration,
  registerNotification,
  type NotificationConfiguration,
} from "../src/notifications.js";

const configuration: NotificationConfiguration = {
  dataSecret: "notification-data-secret-longer-than-thirty-two-characters",
  relaySecret: "notification-relay-secret-longer-than-thirty-two-characters",
  relayUrl: "https://script.google.com/macros/s/example/exec",
  publicAppOrigin: "https://product.test",
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM scan_requests; DELETE FROM scan_notifications;");
});

async function terminalRequest(requestId: string, username: string): Promise<void> {
  const store = new D1Store(env.DB);
  await store.createRequest({ requestId, username, nowMs: 1 });
  await store.failRequest({
    requestId,
    reason: "GITHUB_NOT_FOUND",
    nowMs: 2,
  });
}

describe("one-shot report notifications", () => {
  it("treats an absent sender as disabled and partial setup as invalid", () => {
    expect(notificationConfiguration({ PUBLIC_APP_ORIGIN: "https://product.test" })).toBeNull();
    expect(() =>
      notificationConfiguration({
        PUBLIC_APP_ORIGIN: "https://product.test",
        NOTIFICATION_DATA_SECRET: configuration.dataSecret,
      }),
    ).toThrow("incomplete notification configuration");
  });

  it("encrypts recipients, signs a fixed relay packet, and erases delivery data", async () => {
    await terminalRequest("req_notify000001", "notify-user");
    expect(
      await registerNotification(env.DB, configuration, {
        requestId: "req_notify000001",
        email: "person@example.com",
        nowMs: 10,
      }),
    ).toBe("queued");

    const pending = await env.DB.prepare(
      `SELECT state, recipient_ciphertext, recipient_iv FROM scan_notifications
       WHERE request_id = ?`,
    )
      .bind("req_notify000001")
      .first<{ state: string; recipient_ciphertext: string; recipient_iv: string }>();
    expect(pending?.state).toBe("pending");
    expect(JSON.stringify(pending)).not.toContain("person@example.com");

    let relayBody: Record<string, unknown> | undefined;
    const relayFetch: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const body = typeof init?.body === "string" ? init.body : "";
      expect(url).toBe(configuration.relayUrl);
      relayBody = JSON.parse(body) as Record<string, unknown>;
      return Promise.resolve(Response.json({ ok: true }));
    };
    const result = await deliverOneNotification(
      env.DB,
      configuration,
      20,
      relayFetch,
    );
    expect(result).toBe("sent");
    expect(relayBody).toMatchObject({
      schemaVersion: 1,
      requestId: "req_notify000001",
      recipient: "person@example.com",
      reportUrl: "https://product.test/?request=req_notify000001",
      issuedAtMs: 20,
    });
    expect(relayBody?.["signature"]).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const sent = await env.DB.prepare(
      `SELECT state, recipient_ciphertext, recipient_iv, sent_at_ms
       FROM scan_notifications WHERE request_id = ?`,
    )
      .bind("req_notify000001")
      .first<{
        state: string;
        recipient_ciphertext: string;
        recipient_iv: string;
        sent_at_ms: number;
      }>();
    expect(sent).toEqual({
      state: "sent",
      recipient_ciphertext: "",
      recipient_iv: "",
      sent_at_ms: 20,
    });
  });

  it("limits one recipient per rolling day and erases data after final failure", async () => {
    await terminalRequest("req_notify000002", "notify-two");
    await terminalRequest("req_notify000003", "notify-three");
    expect(
      await registerNotification(env.DB, configuration, {
        requestId: "req_notify000002",
        email: "same@example.com",
        nowMs: 100,
      }),
    ).toBe("queued");
    expect(
      await registerNotification(env.DB, configuration, {
        requestId: "req_notify000003",
        email: "same@example.com",
        nowMs: 101,
      }),
    ).toBe("rate_limited");

    const failedFetch: typeof fetch = () =>
      Promise.resolve(new Response("no", { status: 503 }));
    expect(await deliverOneNotification(env.DB, configuration, 200, failedFetch)).toBe(
      "retry",
    );
    expect(
      await deliverOneNotification(env.DB, configuration, 5 * 60 * 1_000 + 201, failedFetch),
    ).toBe("retry");
    expect(
      await deliverOneNotification(env.DB, configuration, 35 * 60 * 1_000 + 202, failedFetch),
    ).toBe("failed");

    const failed = await env.DB.prepare(
      `SELECT state, attempt_count, recipient_ciphertext, recipient_iv
       FROM scan_notifications WHERE request_id = ?`,
    )
      .bind("req_notify000002")
      .first<Record<string, unknown>>();
    expect(failed).toEqual({
      state: "failed",
      attempt_count: 3,
      recipient_ciphertext: "",
      recipient_iv: "",
    });
  });
});
