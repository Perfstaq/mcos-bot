import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { rawPrisma } from "../db.js";
import { verifyRecallSignature } from "../integrations/recall.js";
import { dedupeKeyFor, readIds, type RecallWebhookPayload } from "../domain/webhook.js";
import { webhookQueue } from "../queue.js";

/**
 * The webhook endpoint.
 *
 * Contract, in order, no exceptions:
 *   1. verify the signature over the RAW body, before anything else
 *   2. reject unverified requests — in every environment, no dev bypass
 *   3. persist the raw payload with a dedupe key
 *   4. enqueue and return 2xx immediately
 *
 * No database lookup of the meeting, no Recall call, no artifact work happens
 * on this thread. Recall retries non-2xx responses, so a slow handler turns
 * one event into several.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/webhooks/recall",
    {
      // Generous, not absent. This endpoint was originally exempted from rate
      // limiting entirely, on the grounds that Recall retries non-2xx and so a
      // 429 would convert one burst into an escalating retry storm. That
      // reasoning holds for *legitimate* traffic and ignores the rest: the route
      // is unauthenticated and publicly reachable, and an unsigned request still
      // costs a full body parse before the signature is even checked.
      //
      // 600/min per IP is roughly two orders of magnitude above real delivery
      // rates, so Recall never sees a 429 in normal operation, while a flood
      // from anywhere else is bounded.
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      // The signature covers the raw body, so an oversized payload is discarded
      // before verification either way. 1MB is far above any real Recall event
      // and well below the 8MB global limit this route has no use for.
      bodyLimit: 1024 * 1024,
    },
    async (request, reply) => {
      const rawBody = request.rawBody ?? "";

      const verification = verifyRecallSignature({
        headers: request.headers as Record<string, string | string[] | undefined>,
        rawBody,
      });

      if (!verification.ok) {
        // Logged for debugging, as Recall's own guidance requires — but never
        // enqueued, stored as processable, or acted on.
        request.log.warn(
          { reason: verification.reason, body: rawBody.slice(0, 500) },
          "rejected unverified webhook",
        );
        return reply.status(401).send({
          error: { code: "invalid_signature", message: verification.reason },
        });
      }

      const payload = (request.body ?? {}) as RecallWebhookPayload;
      const ids = readIds(payload);
      const key = dedupeKeyFor(ids);

      // skipDuplicates rather than catch-P2002: a redelivery is an expected,
      // documented outcome, and expressing it as a caught exception would put a
      // constraint-violation line in the log every time Recall retries.
      const inserted = await rawPrisma.webhookEvent.createMany({
        data: [
          {
            eventType: ids.eventType,
            dedupeKey: key,
            botId: ids.botId,
            recordingId: ids.recordingId,
            transcriptId: ids.transcriptId,
            payload: payload as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });

    if (inserted.count === 0) {
      request.log.info({ dedupeKey: key }, "duplicate webhook ignored");
      return reply.status(200).send({ received: true });
    }

    const event = await rawPrisma.webhookEvent.findUniqueOrThrow({
      where: { dedupeKey: key },
      select: { id: true },
    });
    await webhookQueue.add("process", { webhookEventId: event.id }, { jobId: `webhook-${event.id}` });

    return reply.status(200).send({ received: true });
    },
  );
}
