// Subscription settings: which topics the daily Q助理 digest should cover for this reader.
// The page is client-driven on purpose — the api owns the subscription row, the browser already
// carries the session cookie, and the topic list is a public endpoint, so a loader would only add
// a server round-trip the client can do itself.
import { SITE } from "@aihot/industry/site";
import { redirect } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/subscriptions";
import { pageMeta } from "../lib/seo";
import { readerOf } from "../lib/reader.server";
import { buttonClass } from "../components/ui/Controls";

export async function loader({ request }: Route.LoaderArgs) {
  if (!readerOf(request)) {
    const url = new URL(request.url);
    throw redirect(`/login?return=${encodeURIComponent(url.pathname)}`);
  }
  return null;
}

export function meta() {
  return pageMeta({ title: "订阅推送", path: "/subscriptions", noindex: true });
}

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store" });

interface TopicOption {
  slug: string;
  name: string;
  group: string;
}
interface SubscriptionState {
  topics: string[];
  enabled: boolean;
}

const GROUP_LABELS: Record<string, string> = { company: "公司 / 产品", field: "技术领域", genre: "内容类型" };
const MAX_TOPICS = 12;

export default function SubscriptionsPage() {
  const [topics, setTopics] = useState<TopicOption[]>([]);
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [topicRes, subRes] = await Promise.all([
          fetch("/api/site/topics"),
          fetch("/api/me/subscription"),
        ]);
        if (!alive) return;
        if (!topicRes.ok || !subRes.ok) throw new Error("读取订阅设置失败，请稍后再试。");
        const topicData = (await topicRes.json()) as { topics: TopicOption[] };
        const subData = (await subRes.json()) as SubscriptionState;
        setTopics(topicData.topics ?? []);
        setState({ topics: subData.topics ?? [], enabled: subData.enabled ?? false });
        setPhase("ready");
      } catch (e) {
        if (!alive) return;
        setError(String((e as Error).message ?? e));
        setPhase("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (slug: string) => {
    setState((s) => {
      if (!s) return s;
      const has = s.topics.includes(slug);
      if (!has && s.topics.length >= MAX_TOPICS) return s;
      return { ...s, topics: has ? s.topics.filter((t) => t !== slug) : [...s.topics, slug] };
    });
    setPhase("ready");
  };

  const save = async () => {
    if (!state) return;
    setPhase("saving");
    setError(null);
    try {
      const res = await fetch("/api/me/subscription", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topics: state.topics, enabled: state.enabled }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "保存失败，请稍后再试。");
      }
      setPhase("saved");
      setTimeout(() => setPhase("ready"), 1800);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setPhase("error");
    }
  };

  const byGroup = (grp: string) => topics.filter((t) => t.group === grp);
  const dirty = phase === "ready" || phase === "error";
  const atLimit = state ? state.topics.length >= MAX_TOPICS : false;

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-10">
      <h1 className="pb-4 pt-5 text-[22px] font-bold text-ink lg:pt-1">订阅推送</h1>
      <p className="text-[14px] leading-relaxed text-ink-2">
        每天早上 8:30，把过去 24 小时内你关注主题的精选内容，通过 Q助理 推送给你。
        最多关注 {MAX_TOPICS} 个主题；不选任何主题并开启订阅，则推送全站精选。
      </p>

      {phase === "loading" && <p className="mt-8 text-[14px] text-ink-3">正在读取…</p>}
      {phase === "error" && <p className="mt-6 text-[14px] text-red-500">{error}</p>}

      {state && (
        <div className="mt-6 space-y-5">
          {(["company", "field", "genre"] as const).map((grp) => {
            const list = byGroup(grp);
            if (list.length === 0) return null;
            return (
              <section key={grp}>
                <h2 className="mb-2 text-[13px] font-medium text-ink-3">{GROUP_LABELS[grp] ?? grp}</h2>
                <div className="flex flex-wrap gap-2">
                  {list.map((t) => {
                    const on = state.topics.includes(t.slug);
                    const blocked = !on && atLimit;
                    return (
                      <button
                        key={t.slug}
                        type="button"
                        onClick={() => toggle(t.slug)}
                        disabled={blocked && phase !== "loading"}
                        className={`rounded-full border px-3.5 py-1.5 text-[13.5px] transition-colors ${
                          on
                            ? "border-transparent bg-accent text-accent-contrast"
                            : blocked
                              ? "border-line-soft text-ink-4 opacity-50"
                              : "border-line-soft text-ink-2 hover:border-ink-3 hover:text-ink"
                        }`}
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <label className="flex items-center gap-3 rounded-2xl border border-line-soft p-4">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={(e) => {
                setState((s) => (s ? { ...s, enabled: e.target.checked } : s));
                setPhase("ready");
              }}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            <span className="text-[14.5px] text-ink">
              开启每日推送
              <span className="block text-[12.5px] text-ink-3">
                {state.topics.length === 0 && state.enabled
                  ? "当前未选主题，开启后将推送全站精选。"
                  : state.topics.length > 0
                    ? `将推送 ${state.topics.length} 个主题下的精选内容。`
                    : "先选择至少一个主题。"}
              </span>
            </span>
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || phase === "saving" || (state.enabled && state.topics.length === 0)}
              className={buttonClass("primary")}
            >
              {phase === "saving" ? "保存中…" : phase === "saved" ? "已保存 ✓" : "保存订阅设置"}
            </button>
            <span className="text-[12.5px] text-ink-3">推送在 Q助理 App 内收到，需已完成数字员工连接。</span>
          </div>
        </div>
      )}
    </div>
  );
}
