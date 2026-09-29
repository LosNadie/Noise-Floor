import { FEATURES } from "@aihot/industry/features";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { OAUTH_PROBE_PATHS, resolveRedirect } from "@aihot/contracts/http-policy";
import { loginExempt, readSiteSession } from "@aihot/contracts/site-session";
import { qzGateOn } from "@aihot/backend/auth/qz";
import { sql } from "@aihot/backend/db";
import { registerSite } from "./routes/site.ts";
import { registerLeaderboard } from "./routes/leaderboard.ts";
import { registerOg } from "./routes/og.ts";
import { registerAdminAuth } from "./routes/admin-auth.ts";
import { registerQzAuth } from "./routes/qz-auth.ts";
import { registerAdmin } from "./routes/admin.ts";
import { registerIngest } from "./routes/ingest.ts";
import { registerV1, registerV1Fallbacks } from "./routes/v1.ts";
import { registerMedia } from "./routes/media.ts";
import { registerFeeds } from "./routes/feeds.ts";
import { registerStatic } from "./routes/static.ts";
import { registerMcp } from "./routes/mcp.ts";
import { sendProblem } from "./http/respond.ts";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    // Access logs never record query strings (tokens, actors).
    disableRequestLogging: true,
    trustProxy: true,
    genReqId: () => randomUUID(),
    bodyLimit: 10 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: false, maxParamLength: 300 },
  });

  app.addHook("onRequest", async (req) => {
    req.requestId = req.id;
  });

  app.addHook("onResponse", async (req, reply) => {
    const path = (req.raw.url ?? "").split("?")[0] ?? "/";
    // The reverse proxy logs every request; the process only notes the slow and the failed.
    const ms = Math.round(reply.elapsedTime);
    if (reply.statusCode >= 500 || (ms >= 1000 && path !== "/api/mcp" && !path.startsWith("/api/img-proxy"))) {
      req.log.warn({ method: req.method, path, status: reply.statusCode, ms }, "request");
    }
  });

  // Central redirect table (shared with the web server).
  app.addHook("onRequest", async (req, reply) => {
    const raw = req.raw.url ?? "/";
    const qi = raw.indexOf("?");
    const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
    const search = qi >= 0 ? raw.slice(qi) : "";
    if (OAUTH_PROBE_PATHS.includes(pathname)) {
      return reply.code(404).header("Cache-Control", "public, max-age=3600").type("application/json").send('{"error":"not_found"}');
    }
    const decision = resolveRedirect(pathname, search);
    if (decision) {
      for (const [k, v] of Object.entries(decision.headers)) reply.header(k, v);
      if (decision.location) return reply.code(decision.status).header("Location", decision.location).send();
      return reply.code(decision.status).type("text/plain; charset=utf-8").send(decision.status === 410 ? "Gone" : "Not found");
    }
  });

  // The reader gate. With QZ_REQUIRE_LOGIN on, everything the reader can see needs a session; the
  // sign-in machinery, the console and the assets the sign-in page needs are listed in `loginExempt`.
  // It runs after the redirect table so legacy addresses still redirect rather than bounce to sign-in.
  app.addHook("onRequest", async (req, reply) => {
    if (!qzGateOn()) return;
    const raw = req.raw.url ?? "/";
    const qi = raw.indexOf("?");
    const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
    if (loginExempt(pathname)) return;
    if (readSiteSession(req.headers.cookie)) return;
    // A browser is sent to the sign-in page; anything else (feed reader, script, agent) gets a 401.
    if ((req.headers.accept ?? "").includes("text/html")) {
      return reply.header("Cache-Control", "no-store").redirect(`/login?${new URLSearchParams({ return: raw.slice(0, 2000) })}`, 302);
    }
    return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Sign in with Q助理 to read this site." });
  });

  // A gated page belongs to one reader, so no shared cache may keep it — whatever the route asked for.
  app.addHook("onSend", async (req, reply) => {
    if (!qzGateOn()) return;
    const raw = req.raw.url ?? "/";
    const qi = raw.indexOf("?");
    if (loginExempt(qi >= 0 ? raw.slice(0, qi) : raw)) return;
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Accel-Expires", "0");
  });

  app.get("/api/health", async (_req, reply) => {
    const started = Date.now();
    await sql`SELECT 1`;
    return reply.header("Cache-Control", "no-store").send({ ok: true, db: "ok", ms: Date.now() - started, release: process.env.AIHOT_RELEASE ?? "dev" });
  });

  registerSite(app);
  if (FEATURES.leaderboard) registerLeaderboard(app);
  registerOg(app);
  registerAdminAuth(app);
  registerQzAuth(app);
  registerAdmin(app);

  registerIngest(app);
  registerV1(app);
  registerMedia(app);

  registerFeeds(app);
  registerStatic(app);
  registerMcp(app);
  registerV1Fallbacks(app);

  app.setNotFoundHandler((req, reply) => {
    if ((req.raw.url ?? "").startsWith("/api/")) {
      return sendProblem(req, reply, { status: 404, code: "not_found", detail: "No such endpoint." });
    }
    return reply.code(404).type("text/plain; charset=utf-8").header("Cache-Control", "public, max-age=60").send("Not found");
  });

  app.setErrorHandler((error, req, reply) => {
    req.log.error({ err: error }, "unhandled");
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 400 || status === 413 || status === 415) {
      return sendProblem(req, reply, { status: status === 400 ? 400 : status, code: "invalid_request", detail: "The request could not be processed." });
    }
    return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "Temporarily unavailable.", retryAfter: 30 });
  });

  return app;
}
