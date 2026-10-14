// Daily-push settings: a single on/off toggle for the morning Q助理 digest.
// The page is client-driven on purpose — the api owns the subscription row and the browser already
// carries the session cookie. Topic filtering was removed on 2026-10-12: the toggle is the only
// setting, it saves immediately on change, and the manual "立即推送" button stays.
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

export default function SubscriptionsPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushPhase, setPushPhase] = useState<"idle" | "pushing" | "pushed" | "push-error">("idle");
  const [pushMessage, setPushMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/me/subscription");
        if (!alive) return;
        if (!res.ok) throw new Error("读取推送设置失败，请稍后再试。");
        const data = (await res.json()) as { enabled?: boolean };
        setEnabled(data.enabled ?? false);
      } catch (e) {
        if (!alive) return;
        setError(String((e as Error).message ?? e));
        setEnabled(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // The toggle saves itself immediately; on failure it rolls back and says why.
  const setDailyPush = async (next: boolean) => {
    if (saving) return;
    const prev = enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/me/subscription", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string; message?: string } | null;
        throw new Error(body?.detail ?? body?.message ?? "保存失败，请稍后再试。");
      }
    } catch (e) {
      setEnabled(prev);
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  };

  // Push the current digest through Q助理 right away; the api says a rejection in the reader's language.
  const pushNow = async () => {
    if (pushPhase === "pushing") return;
    setPushPhase("pushing");
    setPushMessage(null);
    try {
      const res = await fetch("/api/me/subscription/push", { method: "POST" });
      if (res.ok) {
        const body = (await res.json()) as { items?: number };
        setPushPhase("pushed");
        setPushMessage(`已推送 ${body.items ?? 0} 条到 Q助理`);
        setTimeout(() => setPushPhase("idle"), 2500);
        return;
      }
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      setPushPhase("push-error");
      setPushMessage(body?.detail ?? "推送失败，请稍后再试。");
    } catch (e) {
      setPushPhase("push-error");
      setPushMessage(String((e as Error).message ?? e));
    }
  };
  const pushDisabled = pushPhase === "pushing" || enabled !== true;

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-10">
      <h1 className="pb-4 pt-5 text-[22px] font-bold text-ink lg:pt-1">订阅推送</h1>
      <p className="text-[14px] leading-relaxed text-ink-2">
        开启后，每天早上 8:30 会把过去 24 小时内的全部精选内容，通过 Q助理 推送给你。
      </p>

      {enabled === null ? (
        <p className="mt-8 text-[14px] text-ink-3">正在读取…</p>
      ) : (
        <div className="mt-6 space-y-5">
          <label className="flex items-center gap-3 rounded-2xl border border-line-soft p-4">
            <input
              type="checkbox"
              checked={enabled}
              disabled={saving}
              onChange={(e) => setDailyPush(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            <span className="text-[14.5px] text-ink">
              开启每日推送
              <span className="block text-[12.5px] text-ink-3">
                {enabled ? "已开启：每天早上 8:30 推送过去 24 小时的全部精选。" : "已关闭：不会收到每日推送。"}
              </span>
            </span>
            {saving && <span className="ml-auto text-[12px] text-ink-3">保存中…</span>}
          </label>

          {error && <p className="text-[13px] text-red-500">{error}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={pushNow}
              disabled={pushDisabled}
              className={buttonClass("secondary")}
            >
              {pushPhase === "pushing" ? "推送中…" : pushPhase === "pushed" ? "已推送 ✓" : "立即推送"}
            </button>
            {pushMessage && (
              <span className={`text-[12.5px] ${pushPhase === "push-error" ? "text-red-500" : "text-ink-3"}`}>{pushMessage}</span>
            )}
            {!pushMessage && <span className="text-[12.5px] text-ink-3">推送在 Q助理 App 内收到，需已完成数字员工连接。</span>}
          </div>
        </div>
      )}
    </div>
  );
}
