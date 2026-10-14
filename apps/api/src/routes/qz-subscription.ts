// Reader daily-push settings: whether the morning Q助理 digest goes to this reader at all.
//
//   GET  /api/me/subscription        →  { enabled }
//   PUT  /api/me/subscription        →  body { enabled: boolean }
//   POST /api/me/subscription/push   →  push the current digest to this reader right away
//
// All require a reader session (the whole site sits behind sign-in anyway, but these endpoints are
// explicit about it: without a session there is no q_uid to subscribe). Topic filtering was
// removed on 2026-10-12 — the digest now always covers ALL selected items of the last 24h, so the
// only setting left is the on/off toggle. The legacy `topics` column stays in the table (harmless,
// kept as-is by the upsert) but is neither read nor written by these endpoints anymore.
import type { FastifyInstance } from "fastify";
import { sql } from "@aihot/backend/db";
import { readSiteSession } from "@aihot/contracts/site-session";
import { pushSubscriptionDigestNow } from "@aihot/backend/notify/qz-digest";
import { sendProblem } from "../http/respond.ts";

export function registerQzSubscription(app: FastifyInstance): void {
  const readerOf = (req: { headers: Record<string, string | string[] | undefined> }) =>
    readSiteSession(req.headers.cookie as string | undefined);

  app.get("/api/me/subscription", async (req, reply) => {
    const reader = readerOf(req);
    if (!reader) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "需要登录后才能读取订阅设置。" });
    const rows = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM qz_subscriptions WHERE q_uid = ${reader.qUid} LIMIT 1`;
    if (rows.length === 0) return reply.send({ enabled: false });
    return reply.send({ enabled: rows[0].enabled });
  });

  app.put("/api/me/subscription", async (req, reply) => {
    const reader = readerOf(req);
    if (!reader) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "需要登录后才能修改订阅设置。" });
    const body = (req.body ?? {}) as { enabled?: unknown };
    const enabled = body.enabled === true;

    await sql`
      INSERT INTO qz_subscriptions (q_uid, enabled, updated_at)
      VALUES (${reader.qUid}, ${enabled}, now())
      ON CONFLICT (q_uid) DO UPDATE SET enabled = ${enabled}, updated_at = now()`;
    return reply.send({ enabled });
  });

  // The subscriptions page's "立即推送": the current digest, pushed to this reader right away.
  // Deliberately not idempotent per day — each press is its own message — but rate-limited by a
  // cooldown inside pushSubscriptionDigestNow, and its rejections are said in the reader's language.
  app.post("/api/me/subscription/push", async (req, reply) => {
    const reader = readerOf(req);
    if (!reader) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "需要登录后才能推送。" });
    const result = await pushSubscriptionDigestNow(reader.qUid);
    if (result.sent) return reply.send({ sent: true, items: result.items });

    const status = result.reason === "failed" ? 502 : result.reason === "not_configured" ? 503 : 409;
    const messages: Record<string, string> = {
      not_configured: "Q助理 推送还没有配置好，请联系管理员。",
      not_enabled: "请先开启订阅推送。",
      not_connected: "你的 Q助理 还没有完成数字员工连接，请先在 Q助理 里完成连接。",
      cooldown: "刚刚已经推送过了，请稍后再试。",
      empty: "过去 24 小时内没有符合条件的精选内容，稍后再来看看。",
      failed: result.detail ?? "推送失败，请稍后再试。",
    };
    return sendProblem(req, reply, { status, code: result.reason, detail: messages[result.reason] ?? "推送失败，请稍后再试。" });
  });
}
