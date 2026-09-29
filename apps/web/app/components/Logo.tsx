// The site's mark (its name from industry/site.ts, set in type) and a small ring mark used as the
// loader. A site with its own logo can replace Wordmark here.
import { useId } from "react";
import { SITE } from "@aihot/industry/site";

/**
 * The mark: a rounded tile in the signature gradient carrying a four-bar waveform — the noise floor
 * the site is named for, drawn at the moment a signal rises out of it. Decorative; the name is set
 * in text beside it, so the mark carries no accessible name of its own.
 */
export function BrandMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  const gid = useId();
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--brand-1, #0064e0)" }} />
          <stop offset="0.52" style={{ stopColor: "var(--brand-2, #7b3fe4)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand-3, #e1306c)" }} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9.6" fill={`url(#${gid})`} />
      <g style={{ fill: "var(--accent-contrast, #ffffff)" }}>
        <rect x="7.3" y="17.6" width="3.2" height="6.4" rx="1.6" opacity="0.7" />
        <rect x="12.4" y="11.8" width="3.2" height="12.2" rx="1.6" opacity="0.88" />
        <rect x="17.5" y="8.3" width="3.2" height="15.7" rx="1.6" />
        <rect x="22.6" y="14.8" width="3.2" height="9.2" rx="1.6" opacity="0.8" />
      </g>
    </svg>
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
