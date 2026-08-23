import { describe, expect, it } from "vitest";
import { verifyRecallSignature } from "../src/integrations/recall.js";
import { signWebhook } from "./helpers.js";

const SECRET = process.env.RECALL_WEBHOOK_SECRET!;
const body = JSON.stringify({ event: "bot.done", data: { bot: { id: "b1" } } });

describe("Recall webhook signature verification", () => {
  it("accepts a correctly signed request", () => {
    const headers = signWebhook({ body });
    expect(verifyRecallSignature({ headers, rawBody: body, secrets: [SECRET] })).toEqual({ ok: true });
  });

  it("accepts legacy svix-* headers from pre-2025-12-15 accounts", () => {
    const headers = signWebhook({ body, headerStyle: "svix" });
    expect(verifyRecallSignature({ headers, rawBody: body, secrets: [SECRET] })).toEqual({ ok: true });
  });

  it("rejects a tampered body — the signature covers the exact bytes", () => {
    const headers = signWebhook({ body });
    const tampered = body.replace("bot.done", "bot.fatal");
    const result = verifyRecallSignature({ headers, rawBody: tampered, secrets: [SECRET] });
    expect(result).toEqual({ ok: false, reason: "no matching signature" });
  });

  it("rejects a signature made with a different secret", () => {
    const headers = signWebhook({ body, secret: "whsec_b3RoZXItc2VjcmV0LXZhbHVl" });
    const result = verifyRecallSignature({ headers, rawBody: body, secrets: [SECRET] });
    expect(result.ok).toBe(false);
  });

  it("rejects a replayed request outside the timestamp window", () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const headers = signWebhook({ body, timestamp: stale });
    const result = verifyRecallSignature({ headers, rawBody: body, secrets: [SECRET] });
    expect(result).toEqual({ ok: false, reason: "timestamp outside tolerance" });
  });

  it("rejects an unsigned request", () => {
    const result = verifyRecallSignature({
      headers: { "content-type": "application/json" },
      rawBody: body,
      secrets: [SECRET],
    });
    expect(result).toEqual({ ok: false, reason: "missing signature headers" });
  });

  it("accepts any signature during a rotation window that sends several", () => {
    const good = signWebhook({ body });
    const rotated = {
      ...good,
      "webhook-signature": `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${good["webhook-signature"]}`,
    };
    expect(verifyRecallSignature({ headers: rotated, rawBody: body, secrets: [SECRET] })).toEqual({
      ok: true,
    });
  });

  it("refuses to verify when no secret is configured", () => {
    const headers = signWebhook({ body });
    const result = verifyRecallSignature({ headers, rawBody: body, secrets: [] });
    expect(result).toEqual({ ok: false, reason: "no webhook secret configured" });
  });
});
