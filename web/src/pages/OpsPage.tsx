import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { formatDateTimeIN } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import type { BalanceDTO, TransactionDTO } from '../../../shared/types';
import { DemoBanner } from '../components/AppShell';
import { BrandMark } from '../components/Gullak';
import { ConfirmDialog, Notice, TxnStatusBadge, useDocumentTitle } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';

interface Overview {
  users: number;
  pendingTransactions: number;
  failedTransactions: number;
  unresolvedExceptions: number;
  providerEvents: Record<string, number>;
  duplicateDeliveries: number;
  rejectedWebhooks: number;
  lastReconciliation: { finishedAt: string; triggeredBy: string; accountsChecked: number; transfersChecked: number; exceptionsOpened: number; exceptionsClosed: number } | null;
  provider: { displayName: string; simulated: boolean };
}
interface ExceptionItem {
  id: string;
  kind: string;
  userId: string | null;
  transactionId: string | null;
  details: Record<string, unknown>;
  status: 'open' | 'escalated' | 'resolved';
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedBy: string | null;
  resolutionNote: string | null;
}
type OpsTxn = TransactionDTO & { userId: string };
interface EventsResponse {
  received: Array<{ id: number; eventId: string; type: string; transferRef: string | null; reference: string | null; processingStatus: string; processingNote: string | null; deliveryCount: number; receivedAt: string }>;
  partnerOutbox: Array<{ id: string; type: string; transferId: string | null; deliveryStatus: string; attempts: number; lastResponseStatus: number | null; createdAt: string }>;
}
interface AuditItem { id: string; operatorId: string; action: string; targetType: string; targetId: string; reason: string; before: unknown; after: unknown; createdAt: string }
interface UserItem { id: string; phoneLast4: string; displayName: string | null; status: string; createdAt: string; totals: BalanceDTO }

const KIND_HELP: Record<string, string> = {
  status_mismatch: 'Partner status differs from the app journal.',
  balance_mismatch: 'Sum of goal pockets differs from the partner ledger balance.',
  missing_at_partner: 'App has a transfer the partner does not know about.',
  missing_in_app: 'Partner has a transfer the app journal does not.',
  amount_mismatch: 'Amounts or direction differ between app and partner.',
  not_submitted: 'Instruction never reached the partner.',
  stuck_pending: 'Pending at both ends for too long.',
  unmatched_event: 'Partner event did not match any transaction.',
  event_mismatch: 'Partner event details did not match the journal.',
  event_conflict: 'Partner event conflicts with the journal state.',
};

type Action = { title: string; description: ReactNode; confirm: string; run: (reason: string) => Promise<unknown> };

function useOps<T>(key: string, path: string, enabled = true) {
  return useQuery({ queryKey: ['ops', key], queryFn: () => api<T>(path), enabled, retry: false });
}

export function OpsPage() {
  useDocumentTitle('Operator console');
  const queryClient = useQueryClient();
  const overview = useOps<Overview>('overview', '/api/ops/overview');
  const [tab, setTab] = useState<'exceptions' | 'transactions' | 'events' | 'users' | 'audit'>('exceptions');
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  const unauthenticated = overview.error instanceof ApiError && overview.error.status === 401;
  const exceptions = useOps<ExceptionItem[]>('exceptions', '/api/ops/exceptions?filter=all', !unauthenticated && tab === 'exceptions');
  const pending = useOps<OpsTxn[]>('transactions', '/api/ops/transactions', !unauthenticated && tab === 'transactions');
  const events = useOps<EventsResponse>('events', '/api/ops/events', !unauthenticated && tab === 'events');
  const users = useOps<UserItem[]>('users', '/api/ops/users', !unauthenticated && tab === 'users');
  const audit = useOps<AuditItem[]>('audit', '/api/ops/audit', !unauthenticated && tab === 'audit');

  const runAction = useMutation({
    mutationFn: ({ act, why }: { act: Action; why: string }) => act.run(why),
    onSuccess: async (_d, { act }) => {
      setFlash(`${act.title}: done. Recorded in the audit log.`);
      setAction(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['ops'] });
    },
  });
  const reconcile = useMutation({
    mutationFn: () => api<{ findings: number; exceptionsOpened: number; exceptionsClosed: number }>('/api/ops/reconciliation/run', { method: 'POST' }),
    onSuccess: async (r) => {
      setFlash(`Reconciliation finished: ${r.findings} finding(s), ${r.exceptionsOpened} new exception(s), ${r.exceptionsClosed} auto-closed.`);
      await queryClient.invalidateQueries({ queryKey: ['ops'] });
    },
  });

  const open = (act: Action) => {
    runAction.reset();
    setReason('');
    setAction(act);
  };

  if (unauthenticated) return <OpsLogin onDone={() => queryClient.invalidateQueries({ queryKey: ['ops'] })} />;

  return (
    <>
      <DemoBanner />
      <header className="topbar">
        <div className="topbar__inner">
          <span className="brand">
            <BrandMark />
            <span>
              Operator console
              <small>Demo support & reconciliation</small>
            </span>
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            style={{ marginLeft: 'auto' }}
            onClick={async () => {
              await api('/api/ops/logout', { method: 'POST' });
              await queryClient.invalidateQueries({ queryKey: ['ops'] });
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="main stack" id="main">
        <h1 tabIndex={-1} data-page-heading>
          Operations
        </h1>
        <Notice tone="info">
          Customer data is limited to the last four phone digits. Every action that changes state requires a reason and is written to the
          append-only audit log. Partner: {overview.data?.provider.displayName ?? '…'}.
        </Notice>
        <div aria-live="polite">{flash ? <Notice tone="ok">{flash}</Notice> : null}</div>

        {overview.data ? (
          <dl className="kpis">
            <Kpi label="Active users" value={overview.data.users} />
            <Kpi label="Pending transfers" value={overview.data.pendingTransactions} />
            <Kpi label="Failed transfers" value={overview.data.failedTransactions} />
            <Kpi label="Open exceptions" value={overview.data.unresolvedExceptions} />
            <Kpi label="Duplicate webhooks absorbed" value={overview.data.duplicateDeliveries} />
            <Kpi label="Rejected webhooks" value={overview.data.rejectedWebhooks} />
          </dl>
        ) : overview.isError ? (
          <Notice tone="error">{errorMessage(overview.error)}</Notice>
        ) : (
          <p role="status">Loading…</p>
        )}

        <section className="card stack" aria-labelledby="recon-title">
          <div className="row-between">
            <div>
              <h2 id="recon-title" style={{ margin: 0 }}>
                Reconciliation
              </h2>
              <p className="small muted" style={{ margin: 0 }}>
                {overview.data?.lastReconciliation
                  ? `Last run ${formatDateTimeIN(overview.data.lastReconciliation.finishedAt)} by ${overview.data.lastReconciliation.triggeredBy}: ${overview.data.lastReconciliation.accountsChecked} accounts, ${overview.data.lastReconciliation.transfersChecked} partner transfers checked.`
                  : 'Not run yet.'}
              </p>
            </div>
            <button type="button" className="btn btn--primary" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
              {reconcile.isPending ? 'Running…' : 'Run reconciliation'}
            </button>
          </div>
          {reconcile.isError ? <Notice tone="error">{errorMessage(reconcile.error)}</Notice> : null}
          <details className="disclosure">
            <summary>Demo tools (mock partner only)</summary>
            <div className="stack">
              <p className="small" style={{ margin: 0 }}>
                Use these to rehearse support scenarios. They only affect the simulated partner.
              </p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  onClick={() =>
                    open({
                      title: 'Settle slow transfers',
                      description: 'The mock partner confirms every transfer created with the “partner is slow” scenario and sends webhooks.',
                      confirm: 'Settle transfers',
                      run: (why) => api('/api/ops/demo/settle-slow', { method: 'POST', body: { reason: why } }),
                    })
                  }
                >
                  Settle slow transfers
                </button>
              </div>
              <p className="tiny muted" style={{ margin: 0 }}>
                To simulate a missed partner reversal, open the Transactions tab. To replay a webhook, open Partner events.
              </p>
            </div>
          </details>
        </section>

        <div className="tabs" role="tablist" aria-label="Operator views">
          {(
            [
              ['exceptions', 'Exceptions'],
              ['transactions', 'Transactions'],
              ['events', 'Partner events'],
              ['users', 'Users'],
              ['audit', 'Audit log'],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
              {label}
            </button>
          ))}
        </div>

        <div role="tabpanel">
          {tab === 'exceptions' ? (
            <Table
              loading={exceptions.isPending}
              error={exceptions.error}
              empty="No exceptions. Run reconciliation to check."
              head={['Kind', 'Status', 'Details', 'Seen', 'Actions']}
              rows={(exceptions.data ?? []).map((e) => [
                <>
                  <strong>{e.kind}</strong>
                  <div className="tiny muted">{KIND_HELP[e.kind]}</div>
                </>,
                <span className={`badge ${e.status === 'resolved' ? 'badge--completed' : e.status === 'escalated' ? 'badge--info' : 'badge--pending'}`}>{e.status}</span>,
                <div className="mono">
                  {e.transactionId ? <div>txn: {e.transactionId}</div> : null}
                  {e.userId ? <div>user: {e.userId}</div> : null}
                  <div>{formatDetails(e.details)}</div>
                  {e.resolutionNote ? <div className="muted">note: {e.resolutionNote} ({e.resolvedBy})</div> : null}
                </div>,
                <span className="tiny">{formatDateTimeIN(e.lastSeenAt)}</span>,
                e.status === 'resolved' ? (
                  <span className="tiny muted">—</span>
                ) : (
                  <div className="btn-row">
                    {e.transactionId && ['status_mismatch', 'stuck_pending', 'event_conflict'].includes(e.kind) ? (
                      <button type="button" className="btn btn--primary btn--small" onClick={() => open(resolveAction(e, 'apply_partner_status'))}>
                        Apply partner status
                      </button>
                    ) : null}
                    {e.kind === 'not_submitted' ? (
                      <button type="button" className="btn btn--primary btn--small" onClick={() => open(resolveAction(e, 'retry_submission'))}>
                        Retry submission
                      </button>
                    ) : null}
                    {e.status === 'open' ? (
                      <button type="button" className="btn btn--secondary btn--small" onClick={() => open(resolveAction(e, 'escalate'))}>
                        Escalate to partner
                      </button>
                    ) : null}
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => open(resolveAction(e, 'mark_resolved'))}>
                      Mark resolved
                    </button>
                  </div>
                ),
              ])}
            />
          ) : null}

          {tab === 'transactions' ? (
            <Table
              loading={pending.isPending}
              error={pending.error}
              empty="No transactions."
              head={['When', 'Transaction', 'Amount', 'Status', 'Demo tool']}
              rows={(pending.data ?? []).map((t) => [
                <span className="tiny">{formatDateTimeIN(t.createdAt)}</span>,
                <div>
                  <div>
                    {t.kind} · {t.goalName} {t.origin !== 'manual' ? <span className="chip">{t.origin}</span> : null}
                  </div>
                  <div className="mono muted">{t.id}</div>
                </div>,
                <span className="num">{formatINR(t.amountPaise)}</span>,
                <TxnStatusBadge status={t.status} />,
                t.status === 'completed' ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() =>
                      open({
                        title: 'Simulate a missed partner reversal',
                        description: `The mock partner will reverse ${formatINR(t.amountPaise)} (${t.id}) without sending a webhook. The app will not know until reconciliation runs.`,
                        confirm: 'Simulate reversal',
                        run: (why) => api('/api/ops/demo/missed-reversal', { method: 'POST', body: { transactionId: t.id, reason: why } }),
                      })
                    }
                  >
                    Simulate missed reversal
                  </button>
                ) : (
                  <span className="tiny muted">—</span>
                ),
              ])}
            />
          ) : null}

          {tab === 'events' ? (
            <div className="stack">
              <h2>Received by the app</h2>
              <Table
                loading={events.isPending}
                error={events.error}
                empty="No partner events yet."
                head={['Received', 'Event', 'Outcome', 'Deliveries', 'Demo tool']}
                rows={(events.data?.received ?? []).map((e) => [
                  <span className="tiny">{formatDateTimeIN(e.receivedAt)}</span>,
                  <div>
                    <div>{e.type}</div>
                    <div className="mono muted">{e.eventId}</div>
                  </div>,
                  <div>
                    <span className={`badge ${e.processingStatus === 'processed' ? 'badge--completed' : e.processingStatus === 'ignored_stale' ? 'badge--info' : 'badge--pending'}`}>
                      {e.processingStatus}
                    </span>
                    {e.processingNote ? <div className="tiny muted">{e.processingNote}</div> : null}
                  </div>,
                  <span className="num">{e.deliveryCount}</span>,
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() =>
                      open({
                        title: 'Replay partner event',
                        description: `The mock partner will deliver ${e.eventId} again. The app should recognise it as a duplicate and change nothing.`,
                        confirm: 'Replay event',
                        run: (why) => api('/api/ops/demo/replay-event', { method: 'POST', body: { eventId: e.eventId, reason: why } }),
                      })
                    }
                  >
                    Replay (duplicate)
                  </button>,
                ])}
              />
              <h2>Mock partner outbox</h2>
              <Table
                loading={events.isPending}
                error={events.error}
                empty="Nothing sent yet."
                head={['Created', 'Event', 'Delivery', 'Attempts', 'Last HTTP status']}
                rows={(events.data?.partnerOutbox ?? []).map((e) => [
                  <span className="tiny">{formatDateTimeIN(e.createdAt)}</span>,
                  <div>
                    <div>{e.type}</div>
                    <div className="mono muted">{e.id}</div>
                  </div>,
                  <span className={`badge ${e.deliveryStatus === 'delivered' ? 'badge--completed' : e.deliveryStatus === 'suppressed' ? 'badge--failed' : 'badge--pending'}`}>
                    {e.deliveryStatus === 'suppressed' ? 'lost (demo)' : e.deliveryStatus}
                  </span>,
                  <span className="num">{e.attempts}</span>,
                  <span className="num">{e.lastResponseStatus ?? '—'}</span>,
                ])}
              />
            </div>
          ) : null}

          {tab === 'users' ? (
            <Table
              loading={users.isPending}
              error={users.error}
              empty="No users."
              head={['User', 'Mobile', 'Status', 'Posted', 'Pending in / out']}
              rows={(users.data ?? []).map((u) => [
                <div>
                  <div>{u.displayName ?? '—'}</div>
                  <div className="mono muted">{u.id}</div>
                </div>,
                <span>••••{u.phoneLast4}</span>,
                <span>{u.status}</span>,
                <span className="num">{formatINR(u.totals.postedPaise)}</span>,
                <span className="num">
                  {formatINR(u.totals.pendingInPaise)} / {formatINR(u.totals.pendingOutPaise)}
                </span>,
              ])}
            />
          ) : null}

          {tab === 'audit' ? (
            <Table
              loading={audit.isPending}
              error={audit.error}
              empty="No operator actions yet."
              head={['When', 'Operator', 'Action', 'Target', 'Reason']}
              rows={(audit.data ?? []).map((a) => [
                <span className="tiny">{formatDateTimeIN(a.createdAt)}</span>,
                <span className="mono">{a.operatorId}</span>,
                <div>
                  <div>{a.action}</div>
                  <div className="mono muted">
                    {a.before ? `before ${JSON.stringify(a.before)}` : ''} {a.after ? `after ${JSON.stringify(a.after)}` : ''}
                  </div>
                </div>,
                <span className="mono">
                  {a.targetType}: {a.targetId}
                </span>,
                <span>{a.reason}</span>,
              ])}
            />
          ) : null}
        </div>
      </main>

      <ConfirmDialog
        open={Boolean(action)}
        title={action?.title ?? ''}
        confirmLabel={action?.confirm ?? 'Confirm'}
        busy={runAction.isPending}
        onCancel={() => setAction(null)}
        onConfirm={() => action && runAction.mutate({ act: action, why: reason })}
      >
        <p style={{ margin: 0 }}>{action?.description}</p>
        <div className="field">
          <label htmlFor="op-reason">Reason (required, saved to the audit log)</label>
          <textarea id="op-reason" className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {runAction.isError ? <Notice tone="error">{errorMessage(runAction.error)}</Notice> : null}
      </ConfirmDialog>
    </>
  );
}

function resolveAction(e: ExceptionItem, actionName: 'apply_partner_status' | 'retry_submission' | 'escalate' | 'mark_resolved'): Action {
  const labels = {
    apply_partner_status: ['Apply partner status', 'The partner’s record is authoritative. The app journal will be moved to the partner’s status, with new ledger entries if money is affected.'],
    retry_submission: ['Retry submission', 'Send the instruction to the partner again using the same idempotency key, so it cannot be duplicated.'],
    escalate: ['Escalate to partner', 'Mark this exception as escalated to the partner’s operations team.'],
    mark_resolved: ['Mark resolved', 'Close this exception without changing any account state.'],
  } as const;
  const [title, description] = labels[actionName];
  return {
    title,
    description: `${description} (${e.kind})`,
    confirm: title,
    run: (reason) => api(`/api/ops/exceptions/${e.id}/resolve`, { method: 'POST', body: { action: actionName, reason } }),
  };
}

function formatDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([k, v]) => (typeof v === 'number' && /Paise$/.test(k) ? `${k.replace(/Paise$/, '')}: ${formatINR(v)}` : `${k}: ${String(v)}`))
    .join(' · ');
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="kpi">
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

function Table({ head, rows, loading, error, empty }: { head: string[]; rows: ReactNode[][]; loading: boolean; error: unknown; empty: string }) {
  if (loading) return <p role="status">Loading…</p>;
  if (error) return <Notice tone="error">{errorMessage(error)}</Notice>;
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpsLogin({ onDone }: { onDone: () => void }) {
  const [passcode, setPasscode] = useState('');
  const login = useMutation({
    mutationFn: () => api('/api/ops/session', { method: 'POST', body: { passcode } }),
    onSuccess: onDone,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <>
      <DemoBanner />
      <main className="welcome" id="main">
        <form className="card stack narrow" style={{ marginInline: 'auto', width: '100%' }} onSubmit={submit}>
          <h1 tabIndex={-1} data-page-heading>
            Operator console
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            For demo support staff. A real deployment would require company single sign-on with multi-factor authentication.
          </p>
          <div className="field">
            <label htmlFor="passcode">Demo passcode</label>
            <input id="passcode" type="password" className="input" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="current-password" />
            <span className="hint">Set by OPERATOR_PASSCODE in .env (default from setup: gullak-ops-demo).</span>
          </div>
          {login.isError ? <Notice tone="error">{errorMessage(login.error)}</Notice> : null}
          <button type="submit" className="btn btn--primary" disabled={!passcode || login.isPending}>
            Sign in
          </button>
          <a href="/" className="small">
            Back to the app
          </a>
        </form>
      </main>
    </>
  );
}
