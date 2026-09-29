// The site's mark — a hand-drawn "noise floor" line: one baseline with uneven strokes rising out of
// it, the signal emerging from the noise. Rendered from industry/brand/mark.png through a CSS mask
// and painted with currentColor, so it follows the theme (ink on light, light on dark) without a
// second asset. A site with its own logo can replace Wordmark here.
import { useId } from "react";
import { SITE } from "@aihot/industry/site";
import markUrl from "@aihot/industry/brand/mark.png?url";

/** The mark: the hand-drawn noise-floor stroke, tinted with the surrounding text color. */
export function BrandMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  const width = Math.round(size * 1.62);
  return (
    <span
      aria-hidden="true"
      focusable="false"
      className={`inline-block shrink-0 ${className}`}
      style={{
        width,
        height: size,
        backgroundColor: "currentColor",
        WebkitMaskImage: `url(${markUrl})`,
        maskImage: `url(${markUrl})`,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap font-extrabold leading-none tracking-[-0.035em] ${className}`}
      style={{ fontSize: size }}
      aria-label={SITE.name}
      role="img"
    >
      <BrandMark size={Math.round(size * 1.16)} className="mr-[0.42em] shrink-0" />
      <span aria-hidden="true">{SITE.name}</span>
    </span>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  const gid = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--brand-1, #0064e0)" }} />
          <stop offset="0.52" style={{ stopColor: "var(--brand-2, #7b3fe4)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand-3, #e1306c)" }} />
        </linearGradient>
      </defs>
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke={`url(#${gid})`} strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill={`url(#${gid})`} />
    </svg>
  );
}
