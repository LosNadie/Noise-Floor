// The daily Q助理 digest for topic subscribers (worker schedule "qz.subscription.digest",
// 08:30 Asia/Shanghai). For every reader who opted in — and connected the agent, which is what
// the platform requires before a push can land — collect the last 24 hours of selected items
// under their topics (an empty topic set means everything) and push one text message.
//
// The subscriptions page can also push the same digest on demand ("立即推送", through the api):
// pushSubscriptionDigestNow below shares the item collection and the message format, but books
// nothing against the daily schedule — the morning digest still goes out as usual.
//
// Safety rails:
//   - the platform's message_id (`digest-<date>-<q_uid>`) makes a platform-level retry a no-op;
//   - a qz_pushes row is what skips the work entirely, so a re-run or a mid-day crash cannot
//     lead to a double send;
//   - readers with nothing to say to them are booked for the day as well, so they are not
//     re-scanned on every retry.
import { randomBytes } from "node:crypto";
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

export interface DigestItem {
  article_id: string;
  title: string;
  summary: string | null;
}

/** The daily push window: everything selected in the last 24 hours. */
const WINDOW_MS = 24 * 3600_000;
const MAX_ITEMS = 8;
const DIGEST_TITLE = "Noise Floor 每日精选";

/** Selected items of the last 24h under the reader's topics, best first. An empty topic set means everything. */
export async function collectDigestItems(topics: string[], now: Date): Promise<DigestItem[]> {
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const tagLists = topics.length > 0
    ? (await Promise.all(topics.map((slug) => loadTopicTags(slug)))).filter((t): t is string[] => t !== null)
    : [];
  const matchTags = [...new Set(tagLists.flat())];
  return matchTags.length > 0
    ? await sql<DigestItem[]>`
        SELECT p.article_id, p.title, p.summary FROM publications p
        WHERE p.visibility = 'public' AND p.selected AND p.visible_after <= ${now} AND p.timeline_at >= ${windowStart}
          AND p.tags && ${matchTags}::text[]
        ORDER BY p.score DESC NULLS LAST, p.timeline_at DESC LIMIT ${MAX_ITEMS}`
    : await sql<DigestItem[]>`
        SELECT p.article_id, p.title, p.summary FROM publications p
        WHERE p.visibility = 'public' AND p.selected AND p.visible_after <= ${now} AND p.timeline_at >= ${windowStart}
        ORDER BY p.score DESC NULLS LAST, p.timeline_at DESC LIMIT ${MAX_ITEMS}`;
}

/** The one text message a digest push carries; identical for the morning job and a manual push.
 * The Q助理 client renders markdown (**bold**, [text](url), lists) but not HTML — verified live. */
export function buildDigestMessage(items: DigestItem[]): string {
  return [
    `**过去 24 小时你关注领域的精选**（${items.length} 条）`,
    "",
    ...items.map((it, i) => `${i + 1}. ${it.title}`),
    "",
    `[打开今日日报 →](${config.siteUrl}/daily)`,
  ].join("\n");
}

export async function runQzSubscriptionDigest(now = new Date()): Promise<SubscriptionDigestOutcome> {
  if (!qzConfigured()) return { pushed: 0, quiet: 0, failed: 0, total: 0 };
  const dateKey = beijingDate(now);

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

      const items = await collectDigestItems(sub.topics, now);
      if (items.length === 0) {
        // Nothing to say today: book the reader for the day so they are not re-scanned.
        await sql`INSERT INTO qz_pushes (message_id, q_uid, date_key, status, detail)
                  VALUES (${messageId}, ${sub.q_uid}, ${dateKey}, 'sent', 'nothing new in the window') ON CONFLICT DO NOTHING`;
        await sql`UPDATE qz_subscriptions SET last_push_date = ${dateKey} WHERE q_uid = ${sub.q_uid}`;
        outcome.quiet++;
        continue;
      }

      await qzPushMessage({
        qUid: sub.q_uid,
        title: DIGEST_TITLE,
        message: buildDigestMessage(items),
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

// ===== The manual "立即推送" push =====

export type ManualPushRejection = "not_configured" | "not_enabled" | "not_connected" | "cooldown" | "empty" | "failed";

export type ManualDigestPush =
  | { sent: true; items: number }
  | { sent: false; items: 0; reason: ManualPushRejection; detail?: string };

/** A reader must wait this long between two manual pushes, so a double-click cannot spam the platform. */
const MANUAL_COOLDOWN = "60 seconds";

export async function pushSubscriptionDigestNow(qUid: string, now = new Date()): Promise<ManualDigestPush> {
  if (!qzConfigured()) return { sent: false, items: 0, reason: "not_configured" };
  const dateKey = beijingDate(now);

  const rows = await sql<{ topics: string[]; enabled: boolean; is_connected_agent: boolean }[]>`
    SELECT s.topics, s.enabled, u.is_connected_agent
    FROM qz_subscriptions s JOIN qz_users u ON u.q_uid = s.q_uid
    WHERE s.q_uid = ${qUid} LIMIT 1`;
  const sub = rows[0];
  if (!sub || !sub.enabled) return { sent: false, items: 0, reason: "not_enabled" };
  if (!sub.is_connected_agent) return { sent: false, items: 0, reason: "not_connected" };

  // Any manual attempt within the window counts, sent or failed — a failing send is retried
  // by a human on a human timescale, not by hammering the button.
  const recent = await sql<{ message_id: string }[]>`
    SELECT message_id FROM qz_pushes
    WHERE q_uid = ${qUid} AND message_id LIKE 'manual-%' AND created_at > now() - ${MANUAL_COOLDOWN}::interval
    LIMIT 1`;
  if (recent.length > 0) return { sent: false, items: 0, reason: "cooldown" };

  // A fresh id per attempt: unlike the daily digest, each press is its own message.
  const messageId = `manual-${dateKey}-${qUid}-${randomBytes(6).toString("hex")}`.replace(/[^A-Za-z0-9._~-]/g, "").slice(0, 64);
  const items = await collectDigestItems(sub.topics, now);
  if (items.length === 0) {
    // Booked anyway, so the cooldown holds and the attempt is on record.
    await sql`INSERT INTO qz_pushes (message_id, q_uid, date_key, status, detail)
              VALUES (${messageId}, ${qUid}, ${dateKey}, 'sent', 'nothing new in the window') ON CONFLICT DO NOTHING`;
    return { sent: false, items: 0, reason: "empty" };
  }

  try {
    await qzPushMessage({
      qUid,
      title: DIGEST_TITLE,
      message: buildDigestMessage(items),
      url: `${config.siteUrl}/daily`,
      messageId,
      importance: 1,
    });
  } catch (error) {
    const detail = error instanceof QzError
      ? `${error.code ?? ""} ${error.message}`.trim()
      : String((error as Error).message ?? error).slice(0, 200);
    await sql`INSERT INTO qz_pushes (message_id, q_uid, date_key, status, detail)
              VALUES (${messageId}, ${qUid}, ${dateKey}, 'failed', ${detail}) ON CONFLICT DO NOTHING`;
    return { sent: false, items: 0, reason: "failed", detail };
  }
  await sql`INSERT INTO qz_pushes (message_id, q_uid, date_key, status) VALUES (${messageId}, ${qUid}, ${dateKey}, 'sent') ON CONFLICT DO NOTHING`;
  return { sent: true, items: items.length };
}
