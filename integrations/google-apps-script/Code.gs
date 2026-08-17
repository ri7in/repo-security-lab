/**
 * No-domain transactional relay for one report-ready email.
 * Required Script Properties: RELAY_SECRET and PUBLIC_APP_ORIGIN.
 * Deploy as a Web App that executes as the owner. Do not log request bodies.
 */

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function base64Url(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/u, "");
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  var difference = 0;
  for (var index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function doPost(event) {
  try {
    var text = event && event.postData && event.postData.contents;
    if (typeof text !== "string" || text.length < 2 || text.length > 4096) {
      return jsonResponse({ ok: false });
    }
    var body = JSON.parse(text);
    var keys = Object.keys(body).sort().join(",");
    if (
      keys !== "issuedAtMs,recipient,reportUrl,requestId,schemaVersion,signature" ||
      body.schemaVersion !== 1 ||
      !/^req_[A-Za-z0-9_-]{4,60}$/u.test(body.requestId) ||
      typeof body.issuedAtMs !== "number" ||
      Math.abs(Date.now() - body.issuedAtMs) > 5 * 60 * 1000 ||
      typeof body.recipient !== "string" ||
      body.recipient.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.recipient) ||
      typeof body.reportUrl !== "string" ||
      typeof body.signature !== "string"
    ) {
      return jsonResponse({ ok: false });
    }

    var properties = PropertiesService.getScriptProperties();
    var secret = properties.getProperty("RELAY_SECRET");
    var origin = properties.getProperty("PUBLIC_APP_ORIGIN");
    if (!secret || secret.length < 32 || !/^https:\/\/[^/]+$/u.test(origin || "")) {
      return jsonResponse({ ok: false });
    }
    var expectedUrl = origin + "/?request=" + body.requestId;
    if (body.reportUrl !== expectedUrl) return jsonResponse({ ok: false });

    var canonical = JSON.stringify({
      schemaVersion: 1,
      requestId: body.requestId,
      recipient: body.recipient,
      reportUrl: body.reportUrl,
      issuedAtMs: body.issuedAtMs,
    });
    var expectedSignature = base64Url(
      Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8),
    );
    if (!constantTimeEqual(body.signature, expectedSignature)) {
      return jsonResponse({ ok: false });
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return jsonResponse({ ok: false });
    try {
      var cache = CacheService.getScriptCache();
      var replayKey = "sent:" + body.requestId;
      if (cache.get(replayKey) === "1") return jsonResponse({ ok: true });
      if (MailApp.getRemainingDailyQuota() < 10) return jsonResponse({ ok: false });
      MailApp.sendEmail({
        to: body.recipient,
        subject: "Your repository security report is ready",
        body:
          "Your public, source-blind repository security report is ready:\n\n" +
          body.reportUrl +
          "\n\nThe report never includes secret values, source snippets, or repository paths.",
        htmlBody:
          "<p>Your public, source-blind repository security report is ready.</p>" +
          '<p><a href="' + body.reportUrl + '">Open the report</a></p>' +
          "<p>The report never includes secret values, source snippets, or repository paths.</p>",
        name: "Repository security report",
      });
      cache.put(replayKey, "1", 21600);
      return jsonResponse({ ok: true });
    } finally {
      lock.releaseLock();
    }
  } catch (_) {
    return jsonResponse({ ok: false });
  }
}

function doGet() {
  return jsonResponse({ ok: false });
}
