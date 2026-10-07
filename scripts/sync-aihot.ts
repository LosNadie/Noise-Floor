// Scheduled incremental sync: aihot.news → Noise Floor.
// Runs every 8h via host cron: docker compose exec -T api node /app/scripts/sync-aihot.ts
// Steps: 1) pull the upstream v1 API (WINDOW, default 24h — 3x overlap at an 8h cadence),
// import with identity_key dedup + replay analyses (zero LLM cost);
// 2) for items imported in THIS run, fetch the full body via /items/:id/markdown and
// convert the `## 正文` section to body_html/body_text (same converter as backfill-aihot-bodies.ts).
// Idempotent end to end — safe to rerun after a failed/partial run.
// Env: WINDOW (default 24h), MAX_ITEMS (0 = all, smoke testing), DELAY_MS (default 350), UA.
import postgres from "postgres";
import { createHash } from "node:crypto";
import { z } from "zod";
import { identityKeyForUrl } from "/app/packages/backend/src/lib/url.ts";
import { publishArticle, publishArticleTx } from "/app/packages/backend/src/publication/publish.ts";
import { modelFor } from "/app/packages/backend/src/editorial/models.ts";
import { chatJson } from "/app/packages/backend/src/providers/llm.ts";
import { enqueue, QUEUES } from "/app/packages/backend/src/jobs/queue.ts";

const SOURCE_ID = "external-aihot"; // legacy aggregate row, kept for old references
const SOURCE_PREFIX = "aihot-s-"; // per-upstream-source rows: id = SOURCE_PREFIX + md5(name).slice(0, 10)
const WINDOW = process.env.WINDOW || "24h";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 0);
const DELAY = Number(process.env.DELAY_MS || 350);
const UA = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
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
    u.searchParams.set("window", WINDOW);
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

// ---- body fetching (verbatim converter from scripts/backfill-aihot-bodies.ts) ----

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline markdown → HTML. Input is escaped FIRST, so quotes arrive as &quot;. */
function inline(s: string): string {
  s = esc(s);
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, alt: string, src: string) =>
    `<img src="${src}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, text: string, href: string) =>
    `<a href="${href}" target="_blank" rel="noopener nofollow">${text}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

/** Block markdown → HTML (headings, paragraphs, lists, quotes, fences, hr, tables). */
function block(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let pbuf: string[] = [];
  const flushP = () => {
    if (pbuf.length) out.push(`<p>${pbuf.map(inline).join("<br>")}</p>`);
    pbuf = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) { flushP(); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushP(); out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`); i++; continue; }
    if (/^```/.test(line)) {
      flushP();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) { buf.push(lines[i]!); i++; }
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      flushP();
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^[-*+]\s+/, "")); i++; }
      out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushP();
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^\d+\.\s+/, "")); i++; }
      out.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ol>`);
      continue;
    }
    if (/^>/.test(line)) {
      flushP();
      const q: string[] = [];
      while (i < lines.length && /^>/.test(lines[i]!)) { q.push(lines[i]!.replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote><p>${q.map(inline).join("<br>")}</p></blockquote>`);
      continue;
    }
    if (/^\|/.test(line)) {
      flushP();
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i]!)) {
        const cells = lines[i]!.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        const [head, ...rest] = rows;
        const th = head!.map((c) => `<th>${inline(c)}</th>`).join("");
        const tb = rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
        out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      }
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushP(); out.push("<hr>"); i++; continue; }
    pbuf.push(line);
    i++;
  }
  flushP();
  return out.join("\n");
}

/** Markdown → displayable plain text (for search_text and the zh translation input). */
function plain(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
}

function cjkRatio(s: string): number {
  const chars = [...s];
  const cjk = chars.filter((c) => /[一-鿿]/.test(c)).length;
  return chars.length ? cjk / chars.length : 0;
}

async function fetchMarkdown(aihotId: string): Promise<{ status: number; md: string }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://aihot.news/items/${aihotId}/markdown`, {
      headers: { accept: "text/markdown, text/plain;q=0.9, */*;q=0.8", "user-agent": UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 5_000 * attempt)); continue; }
    if (res.status === 403 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2_000 * attempt)); continue; }
    return { status: res.status, md: res.ok ? await res.text() : "" };
  }
  return { status: -1, md: "" };
}

const BODY_HEADER = /^## 正文(?:\s*·\s*(?:原文|AI 翻译))?\s*$/m;

// ---- step 0: self-heal any imported rows that have a body but body_mode !== 'full' ----

const stale = await sql<{ article_id: string }[]>`
  SELECT p.article_id FROM publications p JOIN articles a ON a.id = p.article_id
  WHERE a.source_id LIKE ${SOURCE_PREFIX + "%"} AND a.body_status = 'ok' AND p.body_mode <> 'full'`;
if (stale.length) {
  let fixed = 0;
  for (const row of stale) {
    try {
      const res = await publishArticle(row.article_id);
      if (res?.changed) fixed++;
    } catch { /* leave for the next run */ }
  }
  console.log(`self-heal republish: fixed=${fixed}/${stale.length}`);
}

// ---- step 1: import ----

const all = await fetchAll();
const items = MAX_ITEMS > 0 ? all.slice(0, MAX_ITEMS) : all;
console.log(`[${new Date().toISOString()}] fetched ${all.length} items from aihot.news (${WINDOW} window), importing ${items.length}`);

let imported = 0;
let dup = 0;
let selectedCount = 0;
let errors = 0;
const errorList: string[] = [];
const importedIds: string[] = [];
const selectedIds: string[] = [];

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
    const raw = { aihot: item, importedFrom: "https://aihot.news", importNote: `sync ${WINDOW} replay` };
    // One source row per upstream source, so cards/detail show the same attribution aihot does.
    const srcName = (item.source?.name ?? "").trim() || "AIHOT 精选转载";
    const srcId = `${SOURCE_PREFIX}${createHash("md5").update(srcName).digest("hex").slice(0, 10)}`;

    const outcome = await sql.begin(async (tx) => {
      await tx`
        INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, enabled, health, imported_from, next_fetch_at)
        VALUES (${srcId}, ${srcName}, 'external', 'T2', 'editorial', true, true, 'ok', 'https://aihot.news', now() + interval '3650 days')
        ON CONFLICT (id) DO NOTHING`;
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO articles (id, source_id, identity_key, url, title, author, language,
          published_at, published_at_claim, discovered_at, source_updated_at, timeline_at,
          backfill, backfill_reason, body_status, processing_state, raw)
        VALUES (${articleId}, ${srcId}, ${identityKey}, ${original}, ${articleTitle}, null, null,
          ${publishedAt}, ${publishedAt}, ${discoveredAt}, null, ${timelineAt},
          true, 'aihot-import', 'none', 'analyzed', ${tx.json(raw)})
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
    importedIds.push(articleId);
    if (outcome && outcome.selected) selectedCount++;
    if (outcome && outcome.selected) selectedIds.push(articleId);
  } catch (err) {
    errors++;
    errorList.push(`${item.id}: ${(err as Error).message}`);
  }
}

console.log(`import done: imported=${imported} dup=${dup} selected=${selectedCount} errors=${errors}`);
if (errorList.length) console.log(`import failures (first 10):\n${errorList.slice(0, 10).join("\n")}`);

// ---- step 2: full bodies for the items imported in this run ----

let ok = 0;
let noBody = 0;
let failed = 0;
const bodyFailures: string[] = [];
const withBody: string[] = [];

for (let n = 0; n < importedIds.length; n++) {
  const id = importedIds[n]!;
  const aihotId = id.replace(/^aihot-/, "");
  const item = items.find((it) => `aihot-${it.id}` === id)!;
  const articleTitle = (item.originalTitle ?? item.title ?? "").trim();
  try {
    const { status, md } = await fetchMarkdown(aihotId);
    if (status !== 200 || !md) {
      failed++;
      bodyFailures.push(`${id}: http ${status}`);
    } else {
      const m = BODY_HEADER.exec(md);
      if (!m) {
        noBody++; // upstream export has no body section — keep terminal 'none'
      } else {
        const section = md.slice(m.index + m[0].length).replace(/^\s*\n/, "").trim();
        const html = block(section);
        const text = plain(section);
        const lang = cjkRatio(articleTitle) > 0.3 ? "zh" : "en";
        // First body image becomes the card thumbnail (media[0], native shape).
        const img = /<img\b[^>]*\ssrc="(https?:\/\/[^"]+)"/i.exec(html)?.[1]?.replace(/&amp;/g, "&");
        const media = img ? [{ url: img, kind: "image" }] : null;
        if (media) {
          await sql`UPDATE articles SET body_text = ${text}, body_html = ${html}, body_status = 'ok', language = ${lang}, media = ${sql.json(media)}, updated_at = now() WHERE id = ${id}`;
        } else {
          await sql`UPDATE articles SET body_text = ${text}, body_html = ${html}, body_status = 'ok', language = ${lang}, updated_at = now() WHERE id = ${id}`;
        }
        ok++;
        withBody.push(id);
      }
    }
  } catch (err) {
    failed++;
    bodyFailures.push(`${id}: ${(err as Error).message}`);
  }
  if ((n + 1) % 100 === 0) console.log(`bodies progress ${n + 1}/${importedIds.length} ok=${ok} noBody=${noBody} failed=${failed}`);
  await new Promise((r) => setTimeout(r, DELAY));
}

console.log(`bodies done: ok=${ok} noBody=${noBody} failed=${failed}`);
if (bodyFailures.length) console.log(`body failures (first 10):\n${bodyFailures.slice(0, 10).join("\n")}`);

// ---- step 3: republish items that gained a body, so body_mode flips summary → full ----

if (withBody.length) {
  let changed = 0;
  const republishErrors: string[] = [];
  for (const id of withBody) {
    try {
      const res = await publishArticle(id);
      if (res?.changed) changed++;
    } catch (err) {
      republishErrors.push(`${id}: ${(err as Error).message}`);
    }
  }
  console.log(`republish done: changed=${changed}/${withBody.length}`);
  if (republishErrors.length) console.log(`republish failures (first 10):\n${republishErrors.slice(0, 10).join("\n")}`);
}

// ---- step 4: selected items get topic tags (one small model call each) + event grouping ----
// Topic pages (/topics) count only selected publications and match on publications.tags
// (analyses.tags ∪ entity:subjects). The upstream API carries no tags, so each selected item
// gets one lightweight "structure" call to pick 0-3 topic slugs; the matching keys of those
// topics are written to analyses.tags and republished. Items are then handed to the event
// grouping queue (embedding recall + confirm) so story pages keep living. A few dozen small
// calls per day at an 8h cadence — bounded by how many items the upstream selects.

if (true) { // always run: the self-heal query below picks up untagged selected items from past runs too
  // Self-heal: also pick up previously imported selected items that never got tags
  // (dedup anchor: the receipt written by this very step) and items not yet grouped.
  const staleTaggable = await sql<{ article_id: string }[]>`
    SELECT a.article_id FROM analyses a JOIN articles ar ON ar.id = a.article_id
    WHERE ar.source_id LIKE ${SOURCE_PREFIX + "%"} AND a.selected AND a.origin = 'replay'
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.purpose = 'structure_article' AND r.subject = 'sync-tags:' || a.article_id)`;
  const taggableIds = [...new Set([...selectedIds, ...staleTaggable.map((r) => r.article_id)])];
  const topics = await sql<{ slug: string; name: string; tags: string[]; entity_id: string | null }[]>`
    SELECT slug, name, tags, entity_id FROM topics ORDER BY position`;
  const keysBySlug = new Map(topics.map((t) => [t.slug, [...new Set([...t.tags, ...(t.entity_id ? [`entity:${t.entity_id}`] : [])])]]));
  const catalog = topics.map((t) => `${t.slug} | ${t.name}`).join("\n");
  const TagSchema = z.object({ topics: z.array(z.string()).max(3) });
  const model = await modelFor("structure");
  let tagged = 0;
  let queued = 0;
  const tagErrors: string[] = [];
  for (const id of taggableIds) {
    try {
      const [row] = await sql<{ title: string; summary: string | null }[]>`
        SELECT title_zh AS title, summary_zh AS summary FROM analyses WHERE article_id = ${id} AND input_revision = 1`;
      if (row) {
        const res = await chatJson({
          model,
          purpose: "structure_article",
          subject: `sync-tags:${id}`,
          promptVersion: "sync-topics-1",
          system: "你是科技媒体的标签编辑。根据文章标题和摘要，从候选专题中挑出文章实质所属的专题，最多 3 个。只选文章核心主题真正属于的专题，宁可少选或不选。",
          user: `标题：${row.title}\n摘要：${row.summary ?? "（无）"}\n\n候选专题（每行：slug | 名称）：\n${catalog}\n\n输出 JSON：{"topics": ["slug", ...]}`,
          schema: TagSchema,
          temperature: 0,
          maxTokens: 120,
        });
        const slugs = (res.data?.topics ?? []).filter((s) => keysBySlug.has(s)).slice(0, 3);
        const keys = [...new Set(slugs.flatMap((s) => keysBySlug.get(s)!))];
        if (keys.length) {
          await sql`UPDATE analyses SET tags = ${keys}::text[] WHERE article_id = ${id} AND input_revision = 1`;
          await publishArticle(id);
          tagged++;
        }
      }
      const [grouped] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM grouping_decisions WHERE article_id = ${id}`;
      if (grouped.n === 0) {
        await enqueue(QUEUES.group, { articleId: id }, { singletonKey: id });
        queued++;
      }
    } catch (err) {
      tagErrors.push(`${id}: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`selected tagging done: tagged=${tagged} grouped(queued)=${queued}/${taggableIds.length}`);
  if (tagErrors.length) console.log(`tagging failures (first 10):\n${tagErrors.slice(0, 10).join("\n")}`);
}
console.log(`[${new Date().toISOString()}] sync finished`);
await sql.end();
// One-shot CLI: force-exit so no lingering open handle keeps node (and the flock-holding
// `docker compose exec` that wraps us) alive forever — a hung run once starved every
// later cron tick via flock -n. Safe: all writes are awaited above.
process.exit(0);
