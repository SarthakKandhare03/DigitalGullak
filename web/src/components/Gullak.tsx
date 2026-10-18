import { useId } from 'react';

/** Golden Gullak (money-pot) motif. Decorative only — money is never "inside" the app. */
export function GullakArt({ className, withCoin = true }: { className?: string; withCoin?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`gullak ${className ?? ''}`} viewBox="0 0 120 128" aria-hidden="true">
      <defs>
        <linearGradient id={`body-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff0c2" />
          <stop offset="0.35" stopColor="#e8bf68" />
          <stop offset="0.7" stopColor="#b5832f" />
          <stop offset="1" stopColor="#6e4c17" />
        </linearGradient>
        <linearGradient id={`rim-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f7dc98" />
          <stop offset="1" stopColor="#9b6f27" />
        </linearGradient>
        <radialGradient id={`coin-${id}`} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#fff7d9" />
          <stop offset="0.5" stopColor="#f0c45a" />
          <stop offset="1" stopColor="#a8751f" />
        </radialGradient>
      </defs>
      <ellipse cx="60" cy="120" rx="38" ry="5" fill="#000" opacity=".5" />
      <path d="M60 38c-27 0-44 18-44 42 0 21 16 36 44 36s44-15 44-36c0-24-17-42-44-42z" fill={`url(#body-${id})`} />
      <path d="M43 29h34a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4H43a4 4 0 0 1-4-4v-5a4 4 0 0 1 4-4z" fill={`url(#rim-${id})`} />
      <rect x="47" y="52" width="26" height="5.5" rx="2.75" fill="#2a1a06" opacity=".8" />
      <path d="M22 86c25 9 51 9 76 0" stroke="#fff6dc" strokeOpacity=".35" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M24 96c24 8 48 8 72 0" stroke="#fff6dc" strokeOpacity=".18" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M31 74c3-12 11-20 22-23" stroke="#fff" strokeOpacity=".55" strokeWidth="5" fill="none" strokeLinecap="round" />
      <circle cx="88" cy="68" r="2" fill="#fff" opacity=".8" />
      {withCoin ? (
        <g className="float">
          <circle cx="60" cy="14" r="11" fill={`url(#coin-${id})`} />
          <circle cx="60" cy="14" r="8" fill="none" stroke="#fff3c9" strokeOpacity=".6" strokeWidth="1.2" />
          <text x="60" y="18.5" textAnchor="middle" fontSize="11.5" fontWeight="800" fill="#6b4710" fontFamily="system-ui, sans-serif">
            ₹
          </text>
        </g>
      ) : null}
    </svg>
  );
}

export function BrandMark({ size = 34 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id={`bm-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fbe8b2" />
          <stop offset="0.5" stopColor="#d9a548" />
          <stop offset="1" stopColor="#8f6624" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="#17150f" stroke="rgba(236,198,119,.35)" />
      <path d="M32 21c-13 0-21 9-21 20 0 10 8 16 21 16s21-6 21-16c0-11-8-20-21-20z" fill={`url(#bm-${id})`} />
      <rect x="23" y="15" width="18" height="7" rx="3" fill="#b9893a" />
      <rect x="25" y="28" width="14" height="3.5" rx="1.75" fill="#2a1a06" opacity=".75" />
    </svg>
  );
}
