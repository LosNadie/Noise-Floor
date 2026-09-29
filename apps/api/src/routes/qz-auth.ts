// Reader sign-in with Q助理: the QR-code authorize flow, its callback, and the session endpoints the
// web layer and the sign-in page use.
//
// The whole flow is three browser hops:
//   /login  →  /api/auth/qz/start  →  open.qzhuli.com/oauth/authorize (the QR code)
//                                    →  /api/auth/qz/callback  →  back to where the reader was going
// The AppSecret is only ever used inside `@aihot/backend/auth/qz`, on the server.
import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { QzError, qzAuthorizeUrl, qzConfigured, qzExchangeCode, qzRedirectUri, qzUserInfo, type QzUserInfo } from "@aihot/backend/auth/qz";
import {
  issueSiteSession,
  parseCookies,
  readSiteSession,
  safeReaderReturn,
  signValue,
  siteSessionCookie,
  verifyValue,
} from "@aihot/contracts/site-session";
import { sendProblem } from "../http/respond.ts";

/** The signed `state`, held in its own short-lived cookie while the reader is away at Q助理. */
const STATE_COOKIE = "nf_qz_state";
const STATE_SECONDS = 600;

const secure = () => config.siteUrl.startsWith("https://");

/** Sign-in is offered only when it is switched on *and* the application credentials are present. */
const signInOffered = () => config.qzLoginEnabled && qzConfigured();

function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure() ? "; Secure" : ""}`;
}

/** Back to the sign-in page, carrying a short reason code the page knows how to say in words. */
function backToLogin(reply: FastifyReply, reason: string, returnTo?: string) {
  const params = new URLSearchParams({ error: reason, ...(returnTo && returnTo !== "/" ? { return: returnTo } : {}) });
  return reply.redirect(`/login?${params}`, 302);
}

/** Records the reader. The session is already valid by now, so a database hiccup must not undo it. */
async function remember(u: QzUserInfo): Promise<void> {
  await sql`
    INSERT INTO qz_users (q_uid, nickname, avatar_url, phone, is_connected_agent, last_login_at)
    VALUES (${u.qUid}, ${u.nickname}, ${u.avatar}, ${u.phone}, ${u.isConnectedAgent}, now())
    ON CONFLICT (q_uid) DO UPDATE SET
      nickname           = excluded.nickname,
      avatar_url         = excluded.avatar_url,
      phone              = coalesce(excluded.phone, qz_users.phone),
      is_connected_agent = excluded.is_connected_agent,
      last_login_at      = now(),
      login_count        = qz_users.login_count + 1`;
}

export function registerQzAuth(app: FastifyInstance) {
  /** What the sign-in page and the site shell need to know before rendering. */
  app.get("/api/auth/qz/options", async (_req, reply) =>
    reply.header("Cache-Control", "no-store").send({
      configured: qzConfigured(),
      enabled: signInOffered(),
      requireLogin: config.qzRequireLogin,
      /** Shown on the console page so the callback address registered there can be checked at a glance. */
      redirectUri: qzRedirectUri(),
    }),
  );

  /** Sends the browser to Q助理, which shows the QR code. */
  app.get("/api/auth/qz/start", async (req, reply) => {
    const returnTo = safeReaderReturn(String((req.query as Record<string, string>).return ?? "/"));
    reply.header("Cache-Control", "no-store");
    if (!signInOffered()) return backToLogin(reply, "unconfigured", returnTo);
    const state = signValue(`${randomBytes(16).toString("base64url")}|${returnTo}`);
    if (!state) return backToLogin(reply, "unconfigured", returnTo);
    let url: string;
    try {
      url = qzAuthorizeUrl(state);
    } catch (error) {
      req.log.error({ err: error }, "qz authorize url failed");
      return backToLogin(reply, "unconfigured", returnTo);
    }
    return reply.header("Set-Cookie", cookieHeader(STATE_COOKIE, state, STATE_SECONDS)).redirect(url, 302);
  });

  /** Where Q助理 sends the browser back: verify the state, trade the code, remember the reader. */
  app.get("/api/auth/qz/callback", async (req, reply) => {
    const q = req.query as Record<string, string>;
    reply.header("Cache-Control", "no-store");
    const expected = verifyValue(parseCookies(req.headers.cookie)[STATE_COOKIE]);
    const given = verifyValue(q.state);
    const returnTo = safeReaderReturn(expected?.split("|")[1]);
    const clearState = cookieHeader(STATE_COOKIE, "", 0);

    if (q.error || !q.code) return reply.header("Set-Cookie", clearState).redirect(`/login?${new URLSearchParams({ error: q.error === "access_denied" ? "denied" : "failed" })}`, 302);
    if (!expected || !given || expected !== given) return reply.header("Set-Cookie", clearState).redirect(`/login?${new URLSearchParams({ error: "state" })}`, 302);

    try {
      const { accessToken, qUid } = await qzExchangeCode(String(q.code));
      const info = await qzUserInfo(accessToken, qUid);
      const value = issueSiteSession({ qUid: info.qUid, name: info.nickname, avatar: info.avatar }, config.qzSessionDays);
      if (!value) return reply.header("Set-Cookie", clearState).redirect(`/login?${new URLSearchParams({ error: "unconfigured" })}`, 302);
      await remember(info).catch((error: unknown) => req.log.error({ err: error, qUid: info.qUid }, "qz user not recorded"));
      req.log.info({ qUid: info.qUid, connected: info.isConnectedAgent }, "reader signed in");
      return reply
        .header("Set-Cookie", [siteSessionCookie(value, config.qzSessionDays * 86400, secure()), clearState])
        .redirect(returnTo, 302);
    } catch (error) {
      if (!(error instanceof QzError)) req.log.error({ err: error }, "qz sign-in failed");
      const reason = error instanceof QzError && error.code ? `qz${error.code}` : "failed";
      return reply.header("Set-Cookie", clearState).redirect(`/login?${new URLSearchParams({ error: reason, ...(returnTo !== "/" ? { return: returnTo } : {}) })}`, 302);
    }
  });

  /** The reader the browser is signed in as, for the site shell. */
  app.get("/api/auth/qz/me", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const reader = readSiteSession(req.headers.cookie);
    if (!reader) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Sign in first." });
    return reply.send(reader);
  });

  /** For a reverse proxy that guards the whole site (auth_request): 204 with a session, else 401. */
  app.get("/api/auth/qz/check", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.code(readSiteSession(req.headers.cookie) ? 204 : 401).send();
  });

  app.post("/api/auth/qz/logout", async (_req, reply) =>
    reply.header("Set-Cookie", siteSessionCookie("", 0, secure())).header("Cache-Control", "no-store").redirect("/login", 303),
  );

  // A plain link is enough to sign out; there is nothing to forge, so GET is accepted too.
  app.get("/api/auth/qz/logout", async (_req, reply) =>
    reply.header("Set-Cookie", siteSessionCookie("", 0, secure())).header("Cache-Control", "no-store").redirect("/login", 302),
  );
}
