// One-off migration for the imported aihot corpus:
// 1) unwrap double-encoded raw (jsonb string → object) so aihot metadata is queryable;
// 2) split the single external-aihot source into one source row per upstream source
//    (display parity with aihot.news: cards/detail show "IT之家", "X：...", ...);
// 3) extract the first body image into media so list cards get thumbnails;
// 4) republish everything touched.
import { createHash } from "node:crypto";
import postgres from "postgres";
import { publishArticle } from "/app/packages/backend/src/publication/publish.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

// 1) unwrap double-encoded raw
const unwrapped = await sql`
  UPDATE articles SET raw = (raw #>> '{}')::jsonb, updated_at = now()
  WHERE source_id = 'external-aihot' AND jsonb_typeof(raw) = 'string' RETURNING id`;
console.log(`raw unwrapped: ${unwrapped.length}`);

// 2) per-source rows + re-point + 3) media extraction
const rows = await sql<{ id: string; src: string | null; body_html: string | null }[]>`
  SELECT id, raw->'aihot'->'source'->>'name' AS src, body_html
  FROM articles WHERE source_id = 'external-aihot'`;

const sources = new Map<string, string>(); // name → id
let repointed = 0;
let mediaSet = 0;
for (const row of rows) {
  const name = (row.src ?? "").trim() || "AIHOT 精选转载";
  let sid = sources.get(name);
  if (!sid) {
    sid = `aihot-s-${createHash("md5").update(name).digest("hex").slice(0, 10)}`;
    await sql`
      INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, enabled, health, imported_from, next_fetch_at)
      VALUES (${sid}, ${name}, 'external', 'T2', 'editorial', true, true, 'ok', 'https://aihot.news', now() + interval '3650 days')
      ON CONFLICT (id) DO NOTHING`;
    sources.set(name, sid);
  }
  const img = /<img\b[^>]*\ssrc="(https?:\/\/[^"]+)"/i.exec(row.body_html ?? "")?.[1]?.replace(/&amp;/g, "&");
  if (img) {
    await sql`UPDATE articles SET source_id = ${sid}, media = ${sql.json([{ url: img, kind: "image" }])}, updated_at = now() WHERE id = ${row.id}`;
    mediaSet++;
  } else {
    await sql`UPDATE articles SET source_id = ${sid}, updated_at = now() WHERE id = ${row.id}`;
  }
  repointed++;
}
console.log(`re-pointed ${repointed} articles across ${sources.size} sources; media set on ${mediaSet}`);

// 4) republish all touched articles (publications.source_id + search_text)
const ids = await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id LIKE 'aihot-s-%'`;
let changed = 0;
let errs = 0;
for (let n = 0; n < ids.length; n++) {
  try {
    const res = await publishArticle(ids[n]!.id);
    if (res?.changed) changed++;
  } catch (err) {
    errs++;
    if (errs <= 5) console.log(`republish error ${ids[n]!.id}: ${(err as Error).message}`);
  }
  if ((n + 1) % 200 === 0) console.log(`republish progress ${n + 1}/${ids.length} changed=${changed} errs=${errs}`);
}
console.log(`republish done: changed=${changed}/${ids.length} errors=${errs}`);

// drop the now-empty aggregate source row
const gone = await sql`DELETE FROM sources WHERE id = 'external-aihot' AND NOT EXISTS (SELECT 1 FROM articles WHERE source_id = 'external-aihot') RETURNING id`;
console.log(`old aggregate source removed: ${gone.length}`);
await sql.end();
