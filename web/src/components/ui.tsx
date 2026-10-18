import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { amountInWords, formatINR, progressPercent } from '../../../shared/money';
import type { ScheduleStatus, TxnStatus } from '../../../shared/types';
import { errorMessage } from '../lib/api';
import { GullakArt } from './Gullak';
import { Icon, type IconName } from './Icon';

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Digital Gullak (Demo)`;
  }, [title]);
}

export function PageHeader({ title, description, back, actions }: { title: string; description?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode }) {
  useDocumentTitle(title);
  return (
    <header className="page-header">
      {back ? (
        <Link to={back.to} className="back-link">
          <Icon name="arrowLeft" size={16} /> {back.label}
        </Link>
      ) : null}
      <div className="row-between">
        <h1 tabIndex={-1} data-page-heading>
          {title}
        </h1>
        {actions}
      </div>
      {description ? <p>{description}</p> : null}
    </header>
  );
}

/** Marks a figure as simulated wherever it could be mistaken for real money. */
export function SimChip({ label = 'Simulated' }: { label?: string }) {
  return (
    <span className="chip chip--sim" title="Demo only — not real money">
      {label}
    </span>
  );
}

export function Money({ paise, signed, className, withWords }: { paise: number; signed?: boolean; className?: string; withWords?: boolean }) {
  const text = formatINR(paise, { signed });
  return (
    <span className={`num ${className ?? ''}`} aria-label={withWords ? `${text}, ${amountInWords(paise)}` : undefined}>
      {text}
    </span>
  );
}

export function Progress({ saved, target, large, label }: { saved: number; target: number; large?: boolean; label: string }) {
  const pct = progressPercent(saved, target);
  return (
    <div
      className={`progress ${large ? 'progress--lg' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}% — ${formatINR(saved)} of ${formatINR(target)}`}
    >
      <div className="progress__bar" style={{ width: `${Math.max(pct, saved > 0 ? 2 : 0)}%` }} />
    </div>
  );
}

const TXN_STATUS_LABEL: Record<TxnStatus, string> = {
  pending: 'Pending',
  completed: 'Completed',
  failed: 'Failed',
  reversed: 'Reversed',
};

export function TxnStatusBadge({ status }: { status: TxnStatus }) {
  return <span className={`badge badge--${status}`}>{TXN_STATUS_LABEL[status]}</span>;
}

export function ScheduleStatusBadge({ status }: { status: ScheduleStatus }) {
  const label = { active: 'Active', paused: 'Paused', cancelled: 'Cancelled' }[status];
  return <span className={`badge badge--${status}`}>{label}</span>;
}

export function Notice({ tone, title, children, icon }: { tone: 'demo' | 'info' | 'warn' | 'error' | 'ok'; title?: string; children?: ReactNode; icon?: IconName }) {
  const defaultIcon: Record<string, IconName> = { demo: 'info', info: 'info', warn: 'alert', error: 'alert', ok: 'check' };
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon name={icon ?? defaultIcon[tone]!} />
      <div>
        {title ? <p><strong>{title}</strong></p> : null}
        {children}
      </div>
    </div>
  );
}

export function DemoNotice({ children }: { children: ReactNode }) {
  return (
    <Notice tone="demo" title="Demo — simulated money">
      {children}
    </Notice>
  );
}

export function LoadingBlock({ label = 'Loading…', lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div role="status" aria-live="polite" className="stack">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: i === 0 ? 120 : 64 }} />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Notice tone="error" title="We couldn’t load this">
      <p>{errorMessage(error)}</p>
      {onRetry ? (
        <button type="button" className="btn btn--secondary btn--small" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </Notice>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card card--flat empty">
      <GullakArt withCoin={false} />
      <h2>{title}</h2>
      {children ? <p className="muted">{children}</p> : null}
      {action}
    </div>
  );
}

/** Accessible confirm dialog built on <dialog> (focus trap and Esc handled by the browser). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Go back',
  tone = 'primary',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <div className="dialog__body">
        <h2 id="dialog-title">{title}</h2>
        <div className="stack">{children}</div>
        <div className="btn-row btn-row--end btn-row--stack">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className={`btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
