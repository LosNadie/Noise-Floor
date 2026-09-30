// One-off: import the past 7 days of aihot.news into the local pool.
// Idempotent — dedup via articles.identity_key (same derivation as the native pipeline),
// so already-present originals (local crawls, X posts) are skipped automatically.
// Usage (inside the api container): node /tmp/import-aihot-week.ts  [MAX_ITEMS=3 for a smoke run]
import postgres from "postgres";
import { identityKeyForUrl } from "/app/packages/backend/src/lib/url.ts";
import { publishArticleTx } from "/app/packages/backend/src/publication/publish.ts";

const SOURCE_ID = "external-aihot";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 0); // 0 = all
const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

type AihotItem = {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  reason: string | null;
  source: { name: string } | null;
  links: { aihot: string; original: string | null };
  publishedAt: string | null;
  discoveredAt: string | null;
  category: string | null;
  score: number | null;
  selected: boolean;
};

async function fetchAll(): Promise<AihotItem[]> {
  const out: AihotItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const u = new URL("https://aihot.news/api/v1/items");
    u.searchParams.set("mode", "all");
    u.searchParams.set("window", "7d");
    u.searchParams.set("by", "published");
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`aihot api ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { items: AihotItem[]; page?: { nextCursor?: string | null; hasMore?: boolean } };
    out.push(...(body.items ?? []));
    if (!body.page?.hasMore || !body.page?.nextCursor) break;
    cursor = body.page.nextCursor;
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

const all = await fetchAll();
const items = MAX_ITEMS > 0 ? all.slice(0, MAX_ITEMS) : all;
console.log(`fetched ${all.length} items from aihot.news (7d window), importing ${items.length}`);

await sql`
  INSERT INTO sources (id, name, kind, tier, participation_mode, config, tags, first_party,
    site_fulltext, syndicate_fulltext, enabled, health, imported_from, next_fetch_at)
  VALUES (${SOURCE_ID}, ${"AIHOT 精选转载"}, 'external', 'T2', 'editorial', '{}'::jsonb, '{}'::text[], false,
    false, false, true, 'ok', 'https://aihot.news', now() + interval '3650 days')
  ON CONFLICT (id) DO NOTHING`;

let imported = 0;
let dup = 0;
let selectedCount = 0;
let errors = 0;
const errorList: string[] = [];

for (const item of items) {
  try {
    const original = item.links?.original ?? item.links?.aihot;
    if (!original || !item.title) {
      errors++;
      errorList.push(`${item.id}: missing url or title`);
      continue;
    }
    const identityKey = identityKeyForUrl(original) ?? `aihot:${item.id}`;
    const articleId = `aihot-${item.id}`;
    const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;
    const discoveredAt = item.discoveredAt ? new Date(item.discoveredAt) : publishedAt ?? new Date();
    const timelineAt = publishedAt ?? discoveredAt;
    // articles.title keeps the source-language headline (native pipeline semantics);
    // analyses.title_zh carries the Chinese title the card shows.
    const articleTitle = (item.originalTitle ?? item.title).trim();
    const raw = { aihot: item, importedFrom: "https://aihot.news", importNote: "7d window replay" };

    const outcome = await sql.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO articles (id, source_id, identity_key, url, title, author, language,
          published_at, published_at_claim, discovered_at, source_updated_at, timeline_at,
          backfill, backfill_reason, body_status, raw)
        VALUES (${articleId}, ${SOURCE_ID}, ${identityKey}, ${original}, ${articleTitle}, null, null,
          ${publishedAt}, ${publishedAt}, ${discoveredAt}, null, ${timelineAt},
          true, 'aihot-import', 'none', ${JSON.stringify(raw)}::jsonb)
        ON CONFLICT (identity_key) DO NOTHING
        RETURNING id`;
      if (inserted.length === 0) return "dup" as const;
      await tx`
        INSERT INTO analyses (article_id, input_revision, origin, model, relevance, category, tags,
          title_zh, summary_zh, reason_zh, score, selected)
        VALUES (${articleId}, 1, 'replay', 'aihot-replay', 'pass', ${item.category ?? null}, '{}'::text[],
          ${item.title.trim()}, ${item.summary ?? null}, ${item.reason ?? null},
          ${item.score ?? null}, ${item.selected === true})`;
      return await publishArticleTx(tx as never, articleId);
    });

    if (outcome === "dup") {
      dup++;
      continue;
    }
    imported++;
    if (outcome && outcome.selected) selectedCount++;
  } catch (err) {
    errors++;
    errorList.push(`${item.id}: ${(err as Error).message}`);
  }
}

const [after] = await sql<{ total: number; eligible: number; selected: number }[]>`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE p.eligible)::int AS eligible,
         count(*) FILTER (WHERE p.selected)::int AS selected
  FROM publications p JOIN articles a ON a.id = p.article_id
  WHERE a.source_id = ${SOURCE_ID}`;

console.log(`imported=${imported} dupSkipped=${dup} selected=${selectedCount} errors=${errors}`);
console.log(`publications[${SOURCE_ID}]: total=${after?.total} eligible=${after?.eligible} selected=${after?.selected}`);
if (errorList.length) console.log(`errors (first 10):\n${errorList.slice(0, 10).join("\n")}`);
await sql.end();
