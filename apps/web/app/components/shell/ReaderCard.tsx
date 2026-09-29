// Who is reading, and the way out. Shown at the foot of the sidebar and at the top of 更多, so the
// desktop and phone shells both have an account entry.
import type { Reader } from "@aihot/contracts/site-session";
import { IconArrowRight } from "../icons";

/** The reader's picture, or their initial over the brand gradient when Q助理 has none. */
function Avatar({ reader, size = 28 }: { reader: Reader; size?: number }) {
  if (reader.avatar) {
    return <img src={reader.avatar} alt="" width={size} height={size} loading="lazy" decoding="async" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span className="grad-brand flex shrink-0 items-center justify-center rounded-full font-semibold text-accent-contrast" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {[...reader.name][0] ?? "Q"}
    </span>
  );
}

export function ReaderCard({ reader, className = "" }: { reader: Reader; className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <Avatar reader={reader} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold leading-tight text-ink">{reader.name}</span>
        <span className="mt-0.5 block text-[11px] leading-tight text-ink-4">已用 Q助理 登录</span>
      </span>
      <form action="/api/auth/qz/logout" method="post">
        <button type="submit" className="rounded-full px-2 py-1 text-[11.5px] text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink-2">
          退出
        </button>
      </form>
    </div>
  );
}

/** The same, as a full-width row for 更多. */
export function ReaderRow({ reader }: { reader: Reader }) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <Avatar reader={reader} size={36} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-ink">{reader.name}</span>
        <span className="mt-0.5 block text-[12px] text-ink-4">已用 Q助理 登录</span>
      </span>
      <form action="/api/auth/qz/logout" method="post">
        <button type="submit" className="inline-flex items-center gap-0.5 rounded-full border border-line px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink">
          退出登录
          <IconArrowRight size={13} />
        </button>
      </form>
    </div>
  );
}
