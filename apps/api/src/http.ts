import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rawPrisma } from "./db.js";
import { runWithContext, type RequestContext } from "./context.js";
import { env } from "./env.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
    ctx?: RequestContext;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, "bad_request", message, details);
  }
  static notFound(message: string) {
    return new ApiError(404, "not_found", message);
  }
  static conflict(message: string) {
    return new ApiError(409, "conflict", message);
  }
  static unprocessable(message: string, details?: unknown) {
    return new ApiError(422, "unprocessable", message, details);
  }
}

/**
 * Milestone 1 has no authentication. Tenancy is real and enforced at the
 * database client; *identity* is supplied by header and falls back to the
 * seeded demo tenant. Replacing this one function with a real session lookup
 * is the entire auth story — nothing downstream reads headers.
 */
async function resolveContext(request: FastifyRequest): Promise<RequestContext | null> {
  const slug = headerValue(request, "x-tenant-slug") ?? env.DEFAULT_TENANT_SLUG;
  const tenant = await rawPrisma.tenant.findUnique({ where: { slug } });
  if (!tenant) return null;
  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    reviewer: headerValue(request, "x-reviewer-email") ?? env.DEFAULT_REVIEWER_EMAIL,
  };
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

export function registerCore(app: FastifyInstance, opts: { spa?: boolean } = {}): void {
  // Keep the raw body: the webhook signature is computed over the exact bytes
  // Recall sent, so a re-serialised object would never verify.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    request.rawBody = text;
    if (text.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook("onRequest", async (request) => {
    request.ctx = (await resolveContext(request)) ?? undefined;
  });

  // AsyncLocalStorage must wrap the rest of the lifecycle, so this hook is
  // callback-style on purpose: `done()` is invoked *inside* the store.
  app.addHook("onRequest", (request, _reply, done) => {
    if (!request.ctx) return done();
    runWithContext(request.ctx, () => done());
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.status)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    if (status >= 500) request.log.error({ err: error }, "unhandled error");
    return reply.status(status).send({
      error: {
        code: status >= 500 ? "internal_error" : "bad_request",
        message: status >= 500 ? "Internal server error" : message,
      },
    });
  });

  // One not-found handler, set once: Fastify allows only one per prefix. When
  // the built SPA is being served, unknown non-API paths are client routes.
  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith("/api") || request.url === "/healthz";
    if (opts.spa && !isApi) return reply.sendFile("index.html");
    return reply.status(404).send({
      error: { code: "not_found", message: `No route for ${request.method} ${request.url}` },
    });
  });
}

export function requireCtx(request: FastifyRequest): RequestContext {
  if (!request.ctx) {
    throw new ApiError(
      400,
      "unknown_tenant",
      `Unknown tenant. Send X-Tenant-Slug, or seed "${env.DEFAULT_TENANT_SLUG}".`,
    );
  }
  return request.ctx;
}

export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store");
}
