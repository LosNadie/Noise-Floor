// The daily Q助理 digest for topic subscribers (worker schedule "qz.subscription.digest",
// 08:30 Asia/Shanghai). For every reader who opted in — and connected the agent, which is what
// the platform requires before a push can land — collect the last 24 hours of selected items
// under their topics (an empty topic set means everything) and push one text message.
//
// Safety rails:
//   - the platform's message_id (`digest-<date>-<q_uid>`) makes a platform-level retry a no-op;
//   - a qz_pushes row is what skips the work entirely, so a re-run or a mid-day crash cannot
//     lead to a double send;
//   - readers with nothing to say to them are booked for the day as well, so they are not
//     re-scanned on every retry.
import { sql } from "../db.ts";
import { beijingDate } from "@aihot/contracts/time";
import { config } from "../config.ts";
import { QzError, qzConfigured, qzPushMessage } from "../auth/qz.ts";
import { loadTopicTags } from "../publication/topics.ts";

export interface SubscriptionDigestOutcome {
  pushed: number;
  quiet: number;
  failed: number;
  total: number;
}

interface SubscriptionRow {
  q_uid: string;
  topics: string[];
}

interface DigestItem {
  article_id: string;
  title: string;
  summary: string | null;
}

/** The daily push window: everything selected in the last 24 hours. */
const WINDOW_MS = 24 * 3600_000;
const MAX_ITEMS = 8;

export async function runQzSubscriptionDigest(now = new Date()): Promise<SubscriptionDigestOutcome> {
  if (!qzConfigured()) return { pushed: 0, quiet: 0, failed: 0, total: 0 };
  const dateKey = beijingDate(now);
  const windowStart = new Date(now.getTime() - WINDOW_MS);

  const subs = await sql<SubscriptionRow[]>`
    SELECT s.q_uid, s.topics FROM qz_subscriptions s
    JOIN qz_users u ON u.q_uid = s.q_uid
    WHERE s.enabled AND u.is_connected_agent
      AND (s.last_push_date IS NULL OR s.last_push_date < ${dateKey})
    ORDER BY s.q_uid`;
  const outcome: SubscriptionDigestOutcome = { pushed: 0, quiet: 0, failed: 0, total: subs.length };

  for (const sub of subs) {
    const messageId = `digest-${dateKey}-${sub.q_uid}`.replace(/[^A-Za-z0-9._~-]/g, "").slice(0, 64);
    try {
      // Already booked today (a crash after send but before bookkeeping lands here).
      const done = await sql<{ status: string }[]>`SELECT status FROM qz_pushes WHERE message_id = ${messageId} LIMIT 1`;
      if (done.length > 0) {
        if (done[0].status === "sent") {
          await sql`UPDATE qz_subscriptions SET last_push_date = ${dateKey} WHERE q_uid = ${sub.q_uid}`;
          outcome.quiet++;
        } else {
          outcome.failed++;
        }
        continue;
      }

      // Selected items of the last 24h under the reader's topics, best first.
      const tagLists = sub.topics.length > 0
        ? (await Promise.all(sub.topics.map((slug) => loadTopicTags(slug)))).filter((t): t is string[] => t !== null)
        : [];
      const matchTags = [...new Set(tagLists.flat())];
      const items = matchTags.length > 0
        ? await sql<DigestItem[]>`
            SELECT p.article_id, p.title, p.summary FROM publications p
            WHERE p.visibility = 'public' AND p.selected AND p.visible_after <= ${now} AND p.timeline_at >= ${windowStart}
              AND p.tags && ${matchTags}::text[]
            ORDER BY p.score DESC NULLS LAST, p.timeline_at DESC LIMIT ${MAX_ITEMS}`
        : await sql<DigestItem[]>`
            SELECT p.article_id, p.title, p.summary FROM publications p
            WHERE p.visibility = 'public' AND p.selected AND p.visible_after <= ${now} AND p.timeline_at >= ${windowStart}
            ORDER BY p.score DESC NULLS LAST, p.timeline_at DESC LIMIT ${MAX_ITEMS}`;

      if (items.length === 0) {
        // Nothing to say today: book the reader for the day so they are not re-scanned.
        await sql`INSERT INTO qz_pushes (message_id, q_uid, date_key, status, detail)
                  VALUES (${messageId}, ${sub.q_uid}, ${dateKey}, 'sent', 'nothing new in the window') ON CONFLICT DO NOTHING`;
        await sql`UPDATE qz_subscriptions SET last_push_date = ${dateKey} WHERE q_uid = ${sub.q_uid}`;
        outcome.quiet++;
        continue;
      }

      const message = [
        `过去 24 小时你关注领域的精选（${items.length} 条）：`,
        "",
        ...items.map((it, i) => `${i + 1}. ${it.title}`),
        "",
        `—— ${config.siteUrl.replace(/^https?:\/\//, "")} · 点击查看今日日报`,
      ].join("\n");
      await qzPushMessage({
        qUid: sub.q_uid,
        title: "Noise Floor 每日精选",
        message,
        url: `${config.siteUrl}/daily`,
        messageId,
        importance: 1,
      });
      await sql`INSERT INTO qz_pushes (message_id, q_uid, date_key, status) VALUES (${messageId}, ${sub.q_uid}, ${dateKey}, 'sent') ON CONFLICT DO NOTHING`;
      await sql`UPDATE qz_subscriptions SET last_push_date = ${dateKey} WHERE q_uid = ${sub.q_uid}`;
      outcome.pushed++;
    } catch (error) {
      const detail = error instanceof QzError
        ? `${error.code ?? ""} ${error.message}`.trim()
        : String((error as Error).message ?? error).slice(0, 200);
      await sql`INSERT INTO qz_pushes (message_id, q_uid, date_key, status, detail)
                VALUES (${messageId}, ${sub.q_uid}, ${dateKey}, 'failed', ${detail}) ON CONFLICT DO NOTHING`;
      outcome.failed++;
    }
  }
  return outcome;
}
