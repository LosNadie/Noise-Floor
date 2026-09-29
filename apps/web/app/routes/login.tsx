// Sign-in with Q助理: the reader scans a QR code in the Q助理 app, and comes back here signed in.
//
// The page itself does nothing clever — the whole flow is three browser hops handled by the api
// (/api/auth/qz/start → open.qzhuli.com → /api/auth/qz/callback), so this is only the doorway and the
// place a failure explains itself.
import { SITE } from "@aihot/industry/site";
import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/login";
import { safeReaderReturn } from "@aihot/contracts/site-session";
import { apiGet } from "../lib/api.server";
import { readerOf } from "../lib/reader.server";
import { Wordmark } from "../components/Logo";
import { buttonClass } from "../components/ui/Controls";

interface Options {
  configured: boolean;
  enabled: boolean;
  requireLogin: boolean;
  redirectUri: string;
}

const ERRORS: Record<string, string> = {
  denied: "你取消了授权。想好了随时再扫一次。",
  state: "登录状态已经失效，请重新扫码。",
  unconfigured: "这个站点还没有完成 Q助理 登录的配置，请联系管理员。",
  failed: "登录没有完成，请再试一次。",
  qz40002: "和 Q助理 的对接配置有问题，请联系管理员。",
  qz40003: "登录凭证已失效，请重新扫码。",
  qz40004: "这次扫码已经用过了或者已过期，请重新扫码。",
  qz40005: "这个 Q助理 账号还没有连接对应的数字员工，请先在 Q助理 里完成连接。",
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const returnTo = safeReaderReturn(url.searchParams.get("return"));
  // Already signed in: there is nothing to do here.
  if (readerOf(request)) throw redirect(returnTo);
  const options = await apiGet<Options>("/api/auth/qz/options", { signal: request.signal }).catch(() => null);
  return { error: url.searchParams.get("error"), returnTo, options };
}

export const meta: Route.MetaFunction = () => [{ title: `登录 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store" });

export default function LoginPage() {
  const { error, returnTo, options } = useLoaderData<typeof loader>();
  const message = error ? (ERRORS[error] ?? ERRORS.failed) : null;
  const ready = options?.enabled === true;
  const startHref = `/api/auth/qz/start?${new URLSearchParams(returnTo === "/" ? {} : { return: returnTo })}`;

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden">
      {/* The brand's light, behind the card. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[380px]" aria-hidden="true">
        <div className="aurora grain size-full" />
      </div>

      <div className="relative flex flex-1 items-center justify-center px-4 py-14">
        <div className="w-full max-w-[400px]">
          <div className="flex justify-center">
            <Wordmark size={26} className="text-ink" />
          </div>
          <p className="mt-3 text-center text-[13.5px] leading-relaxed text-ink-3">{SITE.tagline}</p>

          <div className="card mt-8 p-6">
            <h1 className="display text-[22px] text-ink">{options?.requireLogin ? "登录后查看" : "登录"}</h1>
            <p className="mt-2.5 text-[13.5px] leading-[1.75] text-ink-3">
              用 Q助理 App 扫一扫即可进入。第一次扫码会在 Q助理 里完成授权，之后这个浏览器就记住了。
            </p>

            {ready ? (
              <a href={startHref} className={`${buttonClass("primary", "lg")} mt-6 w-full`}>
                使用 Q助理 登录
              </a>
            ) : (
              <p className="mt-6 rounded-control bg-amber-soft px-3.5 py-3 text-[12.5px] leading-relaxed text-amber-ink">
                这个站点还没有配置 Q助理 登录，请联系管理员。
              </p>
            )}

            {message && (
              <p role="alert" className="mt-3 text-[12.5px] leading-relaxed text-hot">
                {message}
              </p>
            )}

            <div className="mt-5 flex items-center gap-2 border-t border-line-soft pt-4 text-[12px] text-ink-4">
              <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden="true" />
              扫码即完成注册与登录，不需要单独设密码
            </div>
          </div>

          <p className="mt-6 text-center text-[12px] leading-relaxed text-ink-4">
            还没有 Q助理？扫码时可以直接用手机号注册，注册完就能继续。
          </p>
        </div>
      </div>
    </div>
  );
}
