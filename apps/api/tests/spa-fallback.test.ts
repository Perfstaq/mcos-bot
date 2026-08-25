import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCore } from "../src/http.js";

/**
 * The not-found handler is the SPA's router: anything it does not recognise as
 * an API call becomes a client route. What it must not do is answer a request
 * for a file with HTML.
 *
 * That is not a hypothetical. `@fastify/static` is registered with
 * `wildcard: false`, which walks the directory once at startup and registers a
 * route per file it finds. Rebuild the frontend while the server is running and
 * every new hashed filename misses, falls through to here, and — before this
 * was fixed — came back as index.html with `content-type: text/html`. The
 * browser then refuses the module script on MIME grounds and renders nothing,
 * reporting an error that points at content types rather than at the stale
 * server that caused it.
 */
describe("SPA fallback", () => {
  let app: FastifyInstance;
  let dist: string;

  beforeAll(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "mcos-spa-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><div id=root></div>");
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(path.join(dist, "assets", "real-a1b2c3.js"), "export default 1;\n");

    app = Fastify();
    registerCore(app, { spa: true });
    await app.register(fastifyStatic, { root: dist, prefix: "/", wildcard: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("serves a client route as the shell", async () => {
    const res = await app.inject({ method: "GET", url: "/meetings/0d315f2c-6072-4031-8898-45ce8" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("id=root");
  });

  it("serves a client route that carries a deep-link query", async () => {
    const res = await app.inject({ method: "GET", url: "/meetings/abc?t=42000&segment=seg-1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("serves an asset that exists", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/real-a1b2c3.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("export default");
  });

  it("404s a missing asset rather than handing back the shell", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/index-STALE99.js" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().error.code).toBe("not_found");
  });

  it("404s a missing asset even when a query string follows the extension", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/index-STALE99.js?v=2" });
    expect(res.statusCode).toBe(404);
  });

  it("still 404s unknown API paths as JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("never lets /readyz fall through to the shell", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});
