import type { FastifyInstance } from "fastify";
import { googleConfigured, microsoftConfigured } from "../env.js";

/**
 * What the sign-in page is allowed to offer.
 *
 * A provider with only half its credential set is not offered at all — the
 * alternative is a button that starts an OAuth round-trip and returns a 500,
 * which reads to the user as "this product is broken" rather than "this
 * deployment did not configure Google".
 *
 * Unauthenticated by definition: it is what an anonymous visitor needs in order
 * to sign in. It leaks nothing beyond which buttons to draw.
 */
export async function authInfoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/providers", async () => ({
    providers: [
      ...(googleConfigured ? ["google" as const] : []),
      ...(microsoftConfigured ? ["microsoft" as const] : []),
    ],
    emailPassword: true,
  }));
}
