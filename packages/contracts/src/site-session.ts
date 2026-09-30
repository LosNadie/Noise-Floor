// The site-wide reader session: who is allowed to read the site at all.
//
// It is a *stateless* signed cookie — a base64url JSON payload plus an HMAC — so both the web server
// and the api can verify it locally, without a database round-trip and without the web process ever
// holding a session table. It is signed with SESSION_SECRET, the same secret the admin session uses,
// so rotating that secret signs every reader out.
//
// The gate is deliberately a *policy* in one place: `loginExempt` below is the single list of paths
// that stay reachable without a session.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SITE_SESSION_COOKIE = "nf_reader";
export const SITE_SESSION_DAYS = 30;

export interface Reader {
  /** The Q助理 user id (`q_...`). */
  qUid: string;
  name: string;
  avatar: string | null;
}

/** Avatar URLs ride inside the cookie; anything longer than this is dropped rather than bloating it. */
const MAX_AVATAR = 300;

function secret(): string | null {
  const value = process.env.SESSION_SECRET;
  return value && value.trim() !== "" ? value : null;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()!).update(payload).digest("base64url");
}

/** Signs a short-lived value — the reader session, and the OAuth `state` that protects the callback. */
export function signValue(value: string): string | null {
  return secret() ? `${value}.${sign(value)}` : null;
}

/** The value back, or null when the signature does not match or there is no secret configured. */
export function verifyValue(signed: string | null | undefined): string | null {
  if (!signed || !secret()) return null;
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(signed.slice(i + 1));
  return expected.length === given.length && timingSafeEqual(expected, given) ? value : null;
}

/** Builds the cookie value, or null when no secret is configured (the gate then stays open). */
export function issueSiteSession(reader: Reader, days = SITE_SESSION_DAYS): string | null {
  if (!secret()) return null;
  const avatar = reader.avatar && reader.avatar.length <= MAX_AVATAR ? reader.avatar : null;
  const claims = { u: reader.qUid, n: reader.name, a: avatar, e: Math.floor(Date.now() / 1000) + days * 86400 };
  return signValue(Buffer.from(JSON.stringify(claims), "utf8").toString("base64url"));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // A malformed value is simply not a cookie we can use.
      }
    }
  }
  return out;
}

/** Verifies the signature and the expiry; returns the reader, or null for anything we cannot trust. */
export function readSiteSession(cookieHeader: string | undefined): Reader | null {
  const body = verifyValue(parseCookies(cookieHeader)[SITE_SESSION_COOKIE]);
  if (!body) return null;
  let claims: { u?: unknown; n?: unknown; a?: unknown; e?: unknown };
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as typeof claims;
  } catch {
    return null;
  }
  if (typeof claims.u !== "string" || !claims.u) return null;
  if (typeof claims.e !== "number" || claims.e * 1000 <= Date.now()) return null;
  return { qUid: claims.u, name: typeof claims.n === "string" && claims.n ? claims.n : claims.u, avatar: typeof claims.a === "string" ? claims.a : null };
}

/** The Set-Cookie value for the reader session (or for clearing it, with `maxAgeSeconds` 0). */
export function siteSessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SITE_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/**
 * Paths reachable without a reader session. Three kinds:
 *  - the sign-in machinery itself (`/login`, `/api/auth/*`) — note that `/api/auth/*` also carries the
 *    *admin* sign-in, which has its own, stricter gate;
 *  - the console, which is gated by the admin session instead (`/admin`, `/api/admin/*`);
 *  - the assets the sign-in page needs to render (build assets, icons, manifest, robots).
 */
const EXEMPT_EXACT = [
  "/login",
  "/robots.txt",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icon.png",
  "/icon-192.png",
  "/apple-icon.png",
  "/logo.svg",
  "/api/health",
];
const EXEMPT_PREFIXES = ["/assets/", "/api/auth/", "/api/admin/", "/admin", "/aihot-skill/"];

export function loginExempt(pathname: string): boolean {
  if (EXEMPT_EXACT.includes(pathname)) return true;
  return EXEMPT_PREFIXES.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix));
}

/**
 * Where to send the visitor after signing in. Only same-site paths: an absolute URL, a
 * protocol-relative `//host`, or anything exotic falls back to the home page.
 */
export function safeReaderReturn(target: string | null | undefined, fallback = "/"): string {
  if (!target) return fallback;
  if (!target.startsWith("/") || target.startsWith("//")) return fallback;
  if (target.startsWith("/login") || target.startsWith("/api/")) return fallback;
  return target.slice(0, 2000);
}
