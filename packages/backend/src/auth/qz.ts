// Q助理 open platform: "使用 Q助理 登录" (QR-code sign-in) and the signed server-to-server calls that
// go with it.
//
// Two things live here and nothing else does:
//   1. the request signature, exactly as the platform documents it;
//   2. the three calls the sign-in flow needs — build the authorize URL, trade the one-time code for a
//      user token, and read that user's profile.
//
// The AppSecret never leaves this process: the browser only ever sees the authorize URL, which is the
// one endpoint that is not signed.
import { createHmac, randomBytes } from "node:crypto";
import { config, credential } from "../config.ts";

const BASE = "https://open.qzhuli.com";
const AUTHORIZE_PATH = "/oauth/authorize";
const TOKEN_PATH = "/oauth/access_token";
const USER_INFO_PATH = "/open/user/info";

/** Where the platform sends the browser back. Must match the callback address in the console. */
export const QZ_CALLBACK_PATH = "/api/auth/qz/callback";

export class QzError extends Error {
  /** The platform's own error code, when it gave one (40001–40006). */
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "QzError";
    this.code = code;
  }
}

export function qzAppKey(): string | null {
  return credential("integrations", "QZ_APP_KEY");
}

function appSecret(): string | null {
  return credential("integrations", "QZ_APP_SECRET");
}

/** Sign-in is offered only when the application's credentials are present. */
export function qzConfigured(): boolean {
  return !!qzAppKey() && !!appSecret();
}

/**
 * Whether the whole site is closed behind sign-in. The gate closes only when sign-in can actually be
 * completed — a missing AppKey must never lock everyone out of a site nobody can sign in to. The web
 * server mirrors this rule (it cannot import this package) in apps/web/server.ts.
 */
export function qzGateOn(): boolean {
  return config.qzRequireLogin && config.qzLoginEnabled && qzConfigured();
}

export function qzRedirectUri(): string {
  return (process.env.QZ_REDIRECT_URI || `${config.siteUrl}${QZ_CALLBACK_PATH}`).trim();
}

/** RFC 3986: unreserved is A-Z a-z 0-9 - . _ ~, so ! * ' ( ) must be escaped too. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Strings as they are, integers in decimal, booleans as true/false, string arrays as compact JSON. */
function canonicalValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value.map((v) => String(v)));
  return String(value);
}

/**
 * The platform's signature: business fields plus app_key/timestamp/nonce (and access_token for business
 * APIs), sorted by field name, RFC 3986 encoded, joined with &, then
 * `METHOD\nPATH\nCANONICAL` signed with the raw AppSecret as HMAC-SHA256, lowercase hex.
 * `app_secret` is a credential, never a business field, and is deliberately not part of this.
 */
function signature(method: string, path: string, fields: Record<string, unknown>, secret: string): string {
  const canonical = Object.keys(fields)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(canonicalValue(fields[key]))}`)
    .join("&");
  return createHmac("sha256", secret).update(`${method.toUpperCase()}\n${path}\n${canonical}`, "utf8").digest("hex");
}

interface Envelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

/** The platform's own error codes, said in the reader's language. */
function describe(code: number | undefined, msg: string | undefined, fallback: string): string {
  switch (code) {
    case 40002:
      return "与 Q助理 的对接配置有问题（签名或会话无效），请联系管理员。";
    case 40003:
      return "登录凭证已失效，请重新扫码。";
    case 40004:
      return "这次扫码已经用过了或者已过期，请重新扫码。";
    case 40005:
      return "这个 Q助理 账号还没有连接对应的数字员工，请先在 Q助理 里完成连接。";
    default:
      return msg && msg.trim() !== "" ? msg : fallback;
  }
}

async function qzPost<T>(path: string, body: Record<string, unknown>, accessToken?: string): Promise<T> {
  const appKey = qzAppKey();
  const secret = appSecret();
  if (!appKey || !secret) throw new QzError("还没有配置 Q助理 的 AppKey / AppSecret");

  const timestamp = Date.now();
  const nonce = randomBytes(24).toString("base64url");
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) if (key !== "app_secret") fields[key] = value;
  fields.app_key = appKey;
  fields.timestamp = timestamp;
  fields.nonce = nonce;
  if (accessToken) fields.access_token = accessToken;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-QZ-App-Key": appKey,
        "X-QZ-Timestamp": String(timestamp),
        "X-QZ-Nonce": nonce,
        "X-QZ-Sign": signature("POST", path, fields, secret),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new QzError(`连不上 Q助理 开放平台：${String((error as Error).message).slice(0, 160)}`);
  }

  let envelope: Envelope<T>;
  try {
    envelope = (await res.json()) as Envelope<T>;
  } catch {
    throw new QzError(`Q助理 返回了无法解析的内容（HTTP ${res.status}）`);
  }
  // A business error can still arrive with HTTP 200, so the code is what counts.
  if (envelope.code !== 200) throw new QzError(describe(envelope.code, envelope.msg, `Q助理 拒绝了这次请求（HTTP ${res.status}）`), envelope.code);
  if (envelope.data === undefined) throw new QzError("Q助理 没有返回数据");
  return envelope.data;
}

/** The one endpoint that is not signed: the browser goes here and the platform shows the QR code. */
export function qzAuthorizeUrl(state: string, scope = "user_info"): string {
  const appKey = qzAppKey();
  if (!appKey) throw new QzError("还没有配置 Q助理 的 AppKey");
  return `${BASE}${AUTHORIZE_PATH}?${new URLSearchParams({ app_key: appKey, redirect_uri: qzRedirectUri(), state, scope })}`;
}

interface TokenData {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  credential_type?: string;
  expires_in?: number;
  user?: { q_uid?: string };
}

/** Trades the one-time code for the reader's own token. */
export async function qzExchangeCode(code: string): Promise<{ accessToken: string; qUid: string }> {
  const secret = appSecret();
  if (!secret) throw new QzError("还没有配置 Q助理 的 AppSecret");
  const data = await qzPost<TokenData>(TOKEN_PATH, { app_secret: secret, grant_type: "authorization_code", code, redirect_uri: qzRedirectUri() });
  if (!data.access_token) throw new QzError("Q助理 没有返回用户凭证");
  return { accessToken: data.access_token, qUid: data.user?.q_uid ?? "" };
}

export interface QzUserInfo {
  qUid: string;
  nickname: string;
  avatar: string | null;
  /** Only present when the application asks for the phone scope and the reader agreed this time. */
  phone: string | null;
  isConnectedAgent: boolean;
}

interface UserInfoData {
  q_uid?: string;
  nickname?: string;
  avatar?: string;
  phone?: string;
  is_connected_agent?: boolean;
}

export async function qzUserInfo(accessToken: string, qUid: string): Promise<QzUserInfo> {
  const data = await qzPost<UserInfoData>(USER_INFO_PATH, { q_uid: qUid }, accessToken);
  return {
    qUid: data.q_uid ?? qUid,
    nickname: (data.nickname ?? "").trim() || "Q助理用户",
    avatar: data.avatar && data.avatar.trim() !== "" ? data.avatar : null,
    phone: data.phone && data.phone.trim() !== "" ? data.phone : null,
    isConnectedAgent: data.is_connected_agent === true,
  };
}

// ===== Message push (server → reader, via the app credential) =====
//
// The daily subscription digest and anything else that reaches a reader through Q助理 goes out
// under the application's own token (client_credentials), not a reader token: a push targets a
// q_uid the app is allowed to write to, as long as that reader authorized the app and connected
// the agent.

interface AppTokenCache {
  value: string;
  expiresAt: number;
}

let appToken: AppTokenCache | null = null;

/** The app-level credential, held in memory until shortly before it expires. */
export async function qzAppToken(): Promise<string> {
  if (appToken && appToken.expiresAt > Date.now() + 60_000) return appToken.value;
  const secret = appSecret();
  if (!secret) throw new QzError("还没有配置 Q助理 的 AppSecret");
  const data = await qzPost<TokenData>(TOKEN_PATH, { app_secret: secret, grant_type: "client_credentials" });
  if (!data.access_token || !data.expires_in) throw new QzError("Q助理 没有返回应用凭证");
  appToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return appToken.value;
}

export interface QzPushInput {
  qUid: string;
  title: string;
  message: string;
  /** Where tapping the message lands; defaults to the platform's own message view. */
  url?: string;
  /** Business idempotency id (1–64 of A-Z a-z 0-9 . _ ~ -). Same id with the same content retries safely. */
  messageId: string;
  importance?: 1 | 2 | 3;
}

/** Sends one message to one reader. Throws QzError; the caller decides how a failure is recorded. */
export async function qzPushMessage(input: QzPushInput): Promise<void> {
  const token = await qzAppToken();
  await qzPost("/open/message/push", {
    q_uid: input.qUid,
    title: input.title,
    message: input.message,
    ...(input.url ? { url: input.url } : {}),
    message_id: input.messageId,
    ...(input.importance ? { message_importance: input.importance } : {}),
  }, token);
}

