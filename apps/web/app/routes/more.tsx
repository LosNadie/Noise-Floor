import { SITE } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import type { Reader } from "@aihot/contracts/site-session";
import type { ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";
import { pageMeta } from "../lib/seo";
import { ThemeSwitch } from "../components/shell/ThemeSwitch";
import { ReaderRow } from "../components/shell/ReaderCard";
import { IconBookmark, IconChart, IconChevronRight, IconClock, IconFlame, IconHeart, IconHistory, IconMessage, IconMoon, IconPlug } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta() {
  return pageMeta({ title: "更多", path: "/more", noindex: true });
}

type Row = { to: string; label: string; icon: ReactNode };

// 2026-10-12：分组小标题去掉，入口平铺；daily/topics/agent/changelog/feedback 已下线。
const ROWS: Row[] = [
  { to: "/subscriptions", label: "订阅推送", icon: <IconClock size={18} /> },
  { to: "/starred", label: "收藏", icon: <IconBookmark size={18} /> },
  { to: "/about", label: `关于 ${SITE.name}`, icon: <IconHeart size={18} /> },
  ...(FEATURES.hotRanking ? [{ to: "/hot", label: "热点榜", icon: <IconFlame size={18} /> }] : []),
  ...(FEATURES.leaderboard ? [{ to: "/leaderboard", label: "模型榜", icon: <IconChart size={18} /> }] : []),
  ...(FEATURES.codexResetMonitor ? [{ to: "/codex-reset", label: "Tibo重置监控", icon: <IconHistory size={18} /> }] : []),
  ...(FEATURES.agentPack ? [{ to: "/agent", label: "Agent 接入", icon: <IconPlug size={18} /> }] : []),
  ...(FEATURES.changelog ? [{ to: "/changelog", label: "更新日志", icon: <IconHistory size={18} /> }] : []),
  ...(FEATURES.feedback ? [{ to: "/feedback", label: "意见反馈", icon: <IconMessage size={18} /> }] : []),
];

export default function MorePage() {
  const root = useRouteLoaderData<{ reader: Reader | null }>("root");
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-8">
      <h1 className="pb-4 pt-5 text-[22px] font-bold text-ink lg:pt-1">更多</h1>
      {root?.reader && (
        <div className="mb-3">
          <ReaderRow reader={root.reader} />
        </div>
      )}
      <div className="space-y-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0 2xl:grid-cols-3">
        <section className="card overflow-hidden">
          <ul className="divide-y divide-line-soft">
            {ROWS.map((r) => (
              <li key={r.to}>
                <Link to={r.to} className="flex h-[50px] items-center gap-3 px-4 text-[15px] font-medium text-ink transition-colors active:bg-bg-sunk lg:hover:bg-bg-sunk">
                  <span className="text-ink-3">{r.icon}</span>
                  <span className="flex-1">{r.label}</span>
                  <IconChevronRight size={16} className="text-ink-4" />
                </Link>
              </li>
            ))}
            <li className="flex h-[58px] items-center gap-3 px-4 text-[15px] font-medium text-ink">
              <span className="text-ink-3">
                <IconMoon size={18} />
              </span>
              <span className="flex-1">外观</span>
              <ThemeSwitch className="w-[124px]" />
            </li>
          </ul>
        </section>
      </div>
      <div className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] text-ink-4">
        <Link to="/terms" className="hover:text-ink-2">使用规则</Link>
        <Link to="/privacy" className="hover:text-ink-2">隐私说明</Link>
        <a href="/feed.xml" className="hover:text-ink-2">RSS</a>
        {SITE.icp && <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="hover:text-ink-2">{SITE.icp}</a>}
      </div>
    </div>
  );
}
