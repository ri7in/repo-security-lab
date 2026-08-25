# No-domain report email relay

This optional adapter sends one fixed transactional email after a report reaches
a terminal state. It uses a dedicated Gmail account and Google Apps Script
`MailApp`, so it does not require an owned domain. Email is never required to
scan or view a report.

## Owner setup

1. Create a dedicated Gmail account for the project. Do not reuse a personal
   inbox.
2. Create a standalone Google Apps Script project and paste `Code.gs` into it.
3. In **Project Settings → Script Properties**, add:
   - `RELAY_SECRET`: a random 32+ character value;
   - `PUBLIC_APP_ORIGIN`: the exact HTTPS origin configured as
     `PUBLIC_APP_ORIGIN` in `apps/control-plane/wrangler.jsonc`.
4. Deploy as **Web app**, execute as the owner, and allow anyone to invoke it.
   The body-level HMAC is the authorization boundary; the script rejects every
   unsigned, stale, replayed, malformed, or wrong-origin packet.
5. This adapter is restricted to one operator-controlled address. Public
   scanning disables it structurally until a separate recipient-consent flow
   exists. Install four Cloudflare secrets without
   printing them:

   ```sh
   pnpm exec wrangler secret put NOTIFICATION_DATA_SECRET --config apps/control-plane/wrangler.jsonc
   pnpm exec wrangler secret put NOTIFICATION_RELAY_SECRET --config apps/control-plane/wrangler.jsonc
   pnpm exec wrangler secret put NOTIFICATION_RELAY_URL --config apps/control-plane/wrangler.jsonc
   pnpm exec wrangler secret put NOTIFICATION_ALLOWED_RECIPIENT --config apps/control-plane/wrangler.jsonc
   ```

   `NOTIFICATION_RELAY_SECRET` must equal the Apps Script `RELAY_SECRET`.
   `NOTIFICATION_RELAY_URL` is the deployed `/exec` URL. Use a separate random
   `NOTIFICATION_DATA_SECRET` for recipient encryption and deduplication.
   `NOTIFICATION_ALLOWED_RECIPIENT` must be an address owned by the operator.
6. Apply migration `0002_notifications.sql`, deploy, and confirm
   `/api/capabilities` reports `emailNotifications: true`.

The control plane accepts at most one message per recipient per rolling 24
hours and 80 total per rolling 24 hours, below the current 100-recipient/day
consumer Apps Script quota. It retries twice with fixed delays, stores the
recipient only as AES-GCM ciphertext plus a keyed hash, and erases ciphertext
after success or final failure. The relay uses a bounded durable marker before
calling MailApp, giving best-effort at-most-once delivery across retries. The
relay accepts no custom subject or body.
The message is sent from the dedicated Gmail account; the Workspace-only
`noReply` option is deliberately not used.

Resend is intentionally dormant until an owned domain exists: its test domain
can send only to the Resend account owner, so it cannot deliver arbitrary user
reports without domain verification.
