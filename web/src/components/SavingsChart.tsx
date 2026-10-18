import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatDateIN } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import type { SavingsHistoryDTO } from '../../../shared/rewards';
import { api } from '../lib/api';
import { SimChip } from './ui';

const RANGES: Array<[SavingsHistoryDTO['range'], string]> = [
  ['1m', '1M'],
  ['3m', '3M'],
  ['6m', '6M'],
  ['1y', '1Y'],
];
const W = 600;
const H = 190;
const TOP = 58;
const BOTTOM = 10;

/** "Savings over time": the user's own confirmed (simulated) balance — never a price or a return. */
export function SavingsChart() {
  const [range, setRange] = useState<SavingsHistoryDTO['range']>('3m');
  const [active, setActive] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gradientId = `sg-${useId().replace(/:/g, '')}`;
  const history = useQuery({
    queryKey: ['insights', range],
    queryFn: () => api<SavingsHistoryDTO>(`/api/insights/savings?range=${range}`),
    placeholderData: (previous) => previous,
  });

  const geometry = useMemo(() => {
    const points = history.data?.points ?? [];
    if (points.length < 2) return null;
    const values = points.map((p) => p.balancePaise);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const xy = points.map((p, i) => ({
      x: (i / (points.length - 1)) * W,
      y: max === min ? (TOP + H - BOTTOM) / 2 : TOP + (1 - (p.balancePaise - min) / span) * (H - TOP - BOTTOM),
    }));
    // Smooth curve through the points (monotone-ish cubic using midpoints).
    let line = `M${xy[0]!.x},${xy[0]!.y}`;
    for (let i = 1; i < xy.length; i++) {
      const prev = xy[i - 1]!;
      const cur = xy[i]!;
      const mx = (prev.x + cur.x) / 2;
      line += ` C${mx},${prev.y} ${mx},${cur.y} ${cur.x},${cur.y}`;
    }
    const area = `${line} L${W},${H} L0,${H} Z`;
    return { xy, line, area };
  }, [history.data]);

  const points = history.data?.points ?? [];
  const index = active ?? points.length - 1;
  const point = points[index];
  const pos = geometry?.xy[index];
  const change = history.data?.changePaise ?? 0;
  const empty = points.every((p) => p.balancePaise === 0);

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || points.length < 2) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setActive(Math.round(ratio * (points.length - 1)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setActive(Math.max(0, index - 1));
    else if (e.key === 'ArrowRight') setActive(Math.min(points.length - 1, index + 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(points.length - 1);
    else return;
    e.preventDefault();
  };

  const label = RANGES.find(([r]) => r === range)![1];

  return (
    <section className="card chart-card" aria-labelledby="chart-title">
      <div className="chart-head">
        <h2 id="chart-title" style={{ margin: 0 }}>
          Savings over time <SimChip />
        </h2>
        {history.data && !empty ? (
          <span className="chart-change" style={{ color: change < 0 ? 'var(--bad)' : undefined }}>
            {label} ({change >= 0 ? '+' : ''}
            {formatINR(change)})
            <span className="tri" aria-hidden="true">
              {change >= 0 ? '▲' : '▼'}
            </span>
          </span>
        ) : null}
      </div>

      {history.isPending ? (
        <div className="skeleton" style={{ height: 180, marginTop: 12 }} role="status" aria-label="Loading chart" />
      ) : history.isError ? (
        <p className="muted small">The chart couldn’t load right now.</p>
      ) : empty ? (
        <p className="muted small" style={{ margin: '24px 0' }}>
          Your chart appears after your first confirmed saving.
        </p>
      ) : (
        <div
          ref={wrapRef}
          className="chart-wrap"
          tabIndex={0}
          role="img"
          aria-label={`Savings over the last ${label}: from ${formatINR(history.data.startBalancePaise)} to ${formatINR(history.data.endBalancePaise)}. Use left and right arrow keys to explore.`}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" style={{ height: 190 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#ecc677" stopOpacity="0.32" />
                <stop offset="0.7" stopColor="#ecc677" stopOpacity="0.05" />
                <stop offset="1" stopColor="#ecc677" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.33, 0.66].map((f) => (
              <line key={f} className="chart-grid" x1="0" x2={W} y1={TOP + f * (H - TOP - BOTTOM)} y2={TOP + f * (H - TOP - BOTTOM)} />
            ))}
            {geometry ? (
              <g key={range} clipPath={`url(#${gradientId}-clip)`}>
                <clipPath id={`${gradientId}-clip`}>
                  <rect className="chart-reveal" x="0" y="0" width={W} height={H} />
                </clipPath>
                <path className="chart-area" d={geometry.area} fill={`url(#${gradientId})`} />
                <path className="chart-line" d={geometry.line} vectorEffect="non-scaling-stroke" />
              </g>
            ) : null}
            {pos ? <line className="chart-cross" x1={pos.x} x2={pos.x} y1={pos.y} y2={H} vectorEffect="non-scaling-stroke" /> : null}
          </svg>
          {pos && point ? (
            <>
              <span
                className="chart-dot-html"
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: `${(pos.x / W) * 100}%`,
                  top: `${(pos.y / H) * 100}%`,
                  width: 12,
                  height: 12,
                  marginLeft: -6,
                  marginTop: -6,
                  borderRadius: '50%',
                  background: 'var(--gold-1)',
                  border: '2px solid #141413',
                  boxShadow: '0 0 12px rgba(236,198,119,.8)',
                }}
              />
              <div
                className="chart-tip"
                aria-live="polite"
                style={{ left: `${Math.min(88, Math.max(12, (pos.x / W) * 100))}%`, top: `${(pos.y / H) * 100}%` }}
              >
                {formatDateIN(point.date)}
                <strong className="num">{formatINR(point.balancePaise)}</strong>
              </div>
            </>
          ) : null}
        </div>
      )}

      <div className="range-chips" role="group" aria-label="Time range">
        {RANGES.map(([value, text]) => (
          <button
            key={value}
            type="button"
            aria-pressed={range === value}
            onClick={() => {
              setRange(value);
              setActive(null);
            }}
          >
            {text}
          </button>
        ))}
      </div>

      {history.data ? (
        <table className="sr-only">
          <caption>Confirmed savings by date (simulated)</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Saved</th>
            </tr>
          </thead>
          <tbody>
            {history.data.points
              .filter((_, i, all) => i % 7 === 0 || i === all.length - 1)
              .map((p) => (
                <tr key={p.date}>
                  <td>{formatDateIN(p.date)}</td>
                  <td>{formatINR(p.balancePaise)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
