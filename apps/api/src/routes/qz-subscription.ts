// Reader topic subscriptions: what the daily Q助理 digest should cover for this reader.
//
//   GET /api/me/subscription  →  { topics, enabled }
//   PUT /api/me/subscription  →  body { topics: string[], enabled: boolean }
//
// Both require a reader session (the whole site sits behind sign-in anyway, but this endpoint is
// explicit about it: without a session there is no q_uid to subscribe). Unknown topic slugs are
// rejected rather than stored, so the digest job never filters against a topic that no longer
// exists.
import type { FastifyInstance } from "fastify";
import { sql } from "@aihot/backend/db";
import { readSiteSession } from "@aihot/contracts/site-session";
import { sendProblem } from "../http/respond.ts";

const MAX_TOPICS = 12;

export function registerQzSubscription(app: FastifyInstance): void {
  const readerOf = (req: { headers: Record<string, string | string[] | undefined> }) =>
    readSiteSession(req.headers.cookie as string | undefined);

  app.get("/api/me/subscription", async (req, reply) => {
    const reader = readerOf(req);
    if (!reader) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "需要登录后才能读取订阅设置。" });
    const rows = await sql<{ topics: string[]; enabled: boolean }[]>`
      SELECT topics, enabled FROM qz_subscriptions WHERE q_uid = ${reader.qUid} LIMIT 1`;
    if (rows.length === 0) return reply.send({ topics: [], enabled: false });
    return reply.send({ topics: rows[0].topics, enabled: rows[0].enabled });
  });

  app.put("/api/me/subscription", async (req, reply) => {
    const reader = readerOf(req);
    if (!reader) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "需要登录后才能修改订阅设置。" });
    const body = (req.body ?? {}) as { topics?: unknown; enabled?: unknown };
    const topics = Array.isArray(body.topics) ? body.topics.filter((t): t is string => typeof t === "string") : [];
    const enabled = body.enabled === true;

    if (topics.length > MAX_TOPICS) {
      return sendProblem(req, reply, { status: 400, code: "too_many_topics", detail: `最多关注 ${MAX_TOPICS} 个主题。` });
    }
    if (topics.length > 0) {
      const known = await sql<{ slug: string }[]>`
        SELECT slug FROM topics WHERE slug = ANY(${topics}::text[])`;
      if (known.length !== new Set(topics).size) {
        return sendProblem(req, reply, { status: 400, code: "unknown_topic", detail: "关注列表里有不存在的主题，请刷新后重试。" });
      }
    }
    if (enabled && topics.length === 0) {
      return sendProblem(req, reply, { status: 400, code: "topics_required", detail: "开启订阅前请先选择至少一个主题。" });
    }

    await sql`
      INSERT INTO qz_subscriptions (q_uid, topics, enabled, updated_at)
      VALUES (${reader.qUid}, ${topics}, ${enabled}, now())
      ON CONFLICT (q_uid) DO UPDATE SET topics = ${topics}, enabled = ${enabled}, updated_at = now()`;
    return reply.send({ topics, enabled });
  });
}
