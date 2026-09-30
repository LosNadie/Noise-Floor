// Tag the imported aihot items so topic-subscriber digests can match them.
// Deterministic, no LLM: company topics match on name mentions (entity subjects),
// field/genre topics on their tag strings, plus a category → genre-tag mapping.
// Re-runnable after future imports; only updates analyses rows that gain tags.
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
const SOURCE_ID = "external-aihot";

type Topic = { slug: string; name: string; grp: string; entity_id: string | null; tags: string[] };
const topics = (await sql<Topic[]>`SELECT slug, name, grp, entity_id, tags FROM topics ORDER BY position`)
  .map((t) => ({
    ...t,
    needles: [...new Set([t.name, ...t.name.split(/\s*\/\s*/), ...t.tags])]
      .filter((n) => n && n.length >= 2)
      .map((n) => n.toLowerCase()),
  }));

// aihot categories that correspond to genre topics on this site.
const CATEGORY_TAG: Record<string, string[]> = {
  "ai-models": ["模型发布"],
  "ai-products": ["产品更新"],
  paper: ["论文"],
  tip: ["教程"],
  opinion: ["观点"],
};

// Known tool/product names that indicate the "AI 编码" field beyond its bare tag.
const EXTRA_TAGS: Record<string, string[]> = {
  编码: ["codex", "copilot", "claude code", "cursor", "windsurf", "编程", "代码", "编码"],
  Agent: ["agent", "智能体"],
};

interface Row {
  id: string;
  analysis_id: number;
  cur_tags: string[];
  cur_subjects: string[];
  title: string;
  orig: string | null;
  summary: string | null;
  category: string | null;
}

const rows = await sql<Row[]>`
  SELECT a.id, an.id AS analysis_id, an.tags AS cur_tags, an.subjects AS cur_subjects,
         a.title, a.raw->'aihot'->>'originalTitle' AS orig, an.summary_zh AS summary, an.category
  FROM articles a JOIN analyses an ON an.article_id = a.id
  WHERE a.source_id = ${SOURCE_ID}`;

let updated = 0;
let untouched = 0;
for (const row of rows) {
  const text = `${row.title} ${row.orig ?? ""} ${row.summary ?? ""}`.toLowerCase();
  const tags = new Set(row.cur_tags);
  const subjects = new Set(row.cur_subjects);
  for (const t of topics) {
    const hit = t.needles.some((n) => text.includes(n));
    if (!hit) continue;
    if (t.entity_id) {
      subjects.add(t.entity_id);
    } else {
      for (const tag of t.tags) tags.add(tag);
    }
  }
  // Field topics also match their curated keyword lists.
  for (const [tag, keys] of Object.entries(EXTRA_TAGS)) {
    if (keys.some((k) => text.includes(k))) tags.add(tag);
  }
  if (row.category && CATEGORY_TAG[row.category]) for (const tag of CATEGORY_TAG[row.category]!) tags.add(tag);

  const nextTags = [...tags].sort();
  const nextSubjects = [...subjects].sort();
  const changed = JSON.stringify(nextTags) !== JSON.stringify([...row.cur_tags].sort()) ||
    JSON.stringify(nextSubjects) !== JSON.stringify([...row.cur_subjects].sort());
  if (!changed) { untouched++; continue; }
  await sql`UPDATE analyses SET tags = ${nextTags}, subjects = ${nextSubjects} WHERE id = ${row.analysis_id}`;
  updated++;
}
console.log(`tagged: updated=${updated} untouched=${untouched} of ${rows.length}`);
await sql.end();
