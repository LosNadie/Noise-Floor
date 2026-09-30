// Backfill: fetch full bodies for the imported aihot items via their public markdown
// export (https://aihot.news/items/<id>/markdown), convert the `## 正文` section to HTML
// and store it in articles.body_html/body_text. Idempotent — only body_status='none' rows.
// Env: DELAY_MS (default 350), LIMIT (0 = all), UA.
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
const UA = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const DELAY = Number(process.env.DELAY_MS || 350);
const LIMIT = Number(process.env.LIMIT || 0);
const SOURCE_ID = "external-aihot";

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

const rows = await sql<{ id: string; title: string }[]>`
  SELECT id, title FROM articles
  WHERE source_id = ${SOURCE_ID} AND body_status = 'none'
  ORDER BY published_at DESC NULLS LAST`;
const todo = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
console.log(`backfilling bodies for ${todo.length} of ${rows.length} imported items`);

let ok = 0;
let noBody = 0;
let failed = 0;
const failures: string[] = [];

for (let n = 0; n < todo.length; n++) {
  const row = todo[n]!;
  const aihotId = row.id.replace(/^aihot-/, "");
  try {
    const { status, md } = await fetchMarkdown(aihotId);
    if (status !== 200 || !md) {
      failed++;
      failures.push(`${row.id}: http ${status}`);
    } else {
      const m = BODY_HEADER.exec(md);
      if (!m) {
        noBody++;
      } else {
        const section = md.slice(m.index + m[0].length).replace(/^\s*\n/, "").trim();
        const html = block(section);
        const text = plain(section);
        const lang = cjkRatio(row.title) > 0.3 ? "zh" : "en";
        await sql`UPDATE articles SET body_text = ${text}, body_html = ${html}, body_status = 'ok', language = ${lang}, updated_at = now() WHERE id = ${row.id}`;
        ok++;
      }
    }
  } catch (err) {
    failed++;
    failures.push(`${row.id}: ${(err as Error).message}`);
  }
  if ((n + 1) % 100 === 0) console.log(`progress ${n + 1}/${todo.length} ok=${ok} noBody=${noBody} failed=${failed}`);
  await new Promise((r) => setTimeout(r, DELAY));
}

console.log(`done: ok=${ok} noBody=${noBody} failed=${failed}`);
if (failures.length) console.log(`failures (first 10):\n${failures.slice(0, 10).join("\n")}`);
await sql.end();
