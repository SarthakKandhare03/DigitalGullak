import { Link, useParams } from 'react-router';
import { formatDateTimeIN } from '../../../shared/dates';
import { amountInWords, formatINR } from '../../../shared/money';
import type { TransactionEventDTO } from '../../../shared/types';
import { ErrorState, LoadingBlock, Notice, PageHeader, SimChip, TxnStatusBadge } from '../components/ui';
import { useTransaction } from '../lib/queries';

function eventTitle(e: TransactionEventDTO): string {
  if (e.type === 'created') return 'Instruction recorded';
  if (e.type === 'submitted') return 'Sent to the simulated partner bank';
  if (e.type === 'submission_error') return 'Partner could not be reached';
  const to = e.toStatus;
  if (to === 'completed') return 'Confirmed by the simulated partner';
  if (to === 'failed') return 'Not completed';
  if (to === 'reversed') return 'Reversed by the partner';
  return 'Status changed';
}

function actorLabel(actor: string): string {
  if (actor === 'user') return 'You';
  if (actor === 'system') return 'Digital Gullak';
  if (actor.startsWith('provider:')) return 'Partner (simulated)';
  if (actor.startsWith('operator:')) return 'Support team';
  return actor;
}

export function TransactionPage() {
  const { transactionId } = useParams();
  const txn = useTransaction(transactionId);
  if (txn.isPending) return <LoadingBlock />;
  if (txn.isError) return <ErrorState error={txn.error} onRetry={() => txn.refetch()} />;
  const t = txn.data;
  const isIn = t.kind === 'contribution';

  return (
    <div className="narrow stack">
      <PageHeader title={isIn ? 'Savings added' : 'Withdrawal'} back={{ to: '/activity', label: 'Activity' }} />
      <section className="card stack" aria-live="polite">
        <div className="review__amount">
          <div className="big num">{formatINR(t.amountPaise, { paise: 'always' })}</div>
          <div className="review__words">{amountInWords(t.amountPaise)}</div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <TxnStatusBadge status={t.status} />
            <SimChip />
            {t.origin === 'sample' ? <span className="chip chip--sample">Sample</span> : null}
            {t.origin === 'schedule' ? <span className="chip">Scheduled</span> : null}
          </div>
        </div>
        {t.status === 'pending' ? (
          <Notice tone="warn" title="Waiting for partner confirmation">
            This is not complete yet. Balances update only after the (simulated) partner confirms.
          </Notice>
        ) : null}
        {t.status === 'failed' ? (
          <Notice tone="error" title="Not completed">
            {t.failureReason ?? 'The partner did not complete this.'} Your goal balance did not change.
          </Notice>
        ) : null}
        {t.status === 'reversed' ? (
          <Notice tone="info" title="Reversed">
            The partner reversed this after it completed, so it no longer counts toward your goal.
          </Notice>
        ) : null}
        <dl className="kv">
          <dt>Goal</dt>
          <dd>
            <Link to={`/goals/${t.goalId}`}>
              {t.goalIcon} {t.goalName}
            </Link>
          </dd>
          <dt>{isIn ? 'From' : 'To'}</dt>
          <dd>{t.counterpartyLabel}</dd>
          {t.memo ? (
            <>
              <dt>Note</dt>
              <dd>{t.memo}</dd>
            </>
          ) : null}
          <dt>Started</dt>
          <dd>{formatDateTimeIN(t.createdAt)}</dd>
          {t.settledAt ? (
            <>
              <dt>{t.status === 'failed' ? 'Closed' : 'Confirmed'}</dt>
              <dd>{formatDateTimeIN(t.settledAt)}</dd>
            </>
          ) : null}
          <dt>Reference</dt>
          <dd className="mono">{t.id}</dd>
          <dt>Partner reference</dt>
          <dd className="mono">{t.providerRef ?? 'Not assigned yet'}</dd>
          <dt>Money moved</dt>
          <dd>No — demo simulation</dd>
        </dl>
      </section>

      <section className="card" aria-labelledby="timeline-title">
        <h2 id="timeline-title">History</h2>
        <p className="tiny muted">Recorded entries are never edited or deleted.</p>
        <ol className="timeline">
          {t.events.map((e) => (
            <li key={e.id}>
              <div className="t-title">{eventTitle(e)}</div>
              <div className="t-meta">
                {formatDateTimeIN(e.createdAt)} · {actorLabel(e.actor)}
                {e.note && e.type !== 'created' ? ` · ${e.note}` : ''}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card card--tint">
        <h2>Something not right?</h2>
        <p className="small" style={{ margin: 0 }}>
          In the live product you would raise this with our support team, quoting the reference above. See <Link to="/help#complaints">complaints</Link>.
          In this demo, no real money was involved.
        </p>
      </section>
    </div>
  );
}
