import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { amountInWords, formatINR, paiseToInputValue, parseRupeesToPaise } from '../../../shared/money';
import type { CreateTransferResponse, DemoScenario, TxnKind } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingBlock, Notice, PageHeader, SimChip, TxnStatusBadge } from '../components/ui';
import { api, errorMessage, newIdempotencyKey } from '../lib/api';
import { useConfig, useDashboard, useGoal, useRefreshMoney, useTransaction } from '../lib/queries';

const PRESETS = [50_00, 100_00, 500_00, 1_000_00];

const COPY: Record<TxnKind, { title: string; verb: string; confirm: string; doneTitle: string }> = {
  contribution: { title: 'Add savings', verb: 'add', confirm: 'Confirm simulated deposit', doneTitle: 'Simulated deposit confirmed' },
  withdrawal: { title: 'Withdraw', verb: 'withdraw', confirm: 'Confirm simulated withdrawal', doneTitle: 'Simulated withdrawal confirmed' },
};

export function TransferFlowPage({ kind }: { kind: TxnKind }) {
  const { goalId } = useParams();
  const navigate = useNavigate();
  const goal = useGoal(goalId);
  const dashboard = useDashboard();
  const config = useConfig();
  const refresh = useRefreshMoney();
  const [step, setStep] = useState<'amount' | 'review' | 'status'>('amount');
  const [amountText, setAmountText] = useState('');
  const [amountPaise, setAmountPaise] = useState(0);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<DemoScenario>('confirm');
  const [transactionId, setTransactionId] = useState<string | undefined>();
  // One key per confirmed intent: double clicks and network retries reuse it, so money can't move twice.
  const idempotencyKey = useRef<string>(newIdempotencyKey());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const copy = COPY[kind];

  const submit = useMutation({
    mutationFn: () =>
      api<CreateTransferResponse>(`/api/goals/${goalId}/${kind}s`, {
        method: 'POST',
        body: { amountPaise, demoScenario: scenario },
        idempotencyKey: idempotencyKey.current,
      }),
    onSuccess: (data) => {
      setTransactionId(data.transaction.id);
      setStep('status');
      void refresh();
    },
  });

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  if (goal.isPending) return <LoadingBlock />;
  if (goal.isError) return <ErrorState error={goal.error} onRetry={() => goal.refetch()} />;
  const g = goal.data;
  const available = g.balance.availablePaise;
  const maxPaise = kind === 'withdrawal' ? Math.min(available, config.data?.limits.maxTransferPaise ?? available) : config.data?.limits.maxTransferPaise;
  const partner = dashboard.data?.partner;
  const bankLabel = partner?.linkedBankAccountLabel ?? 'Your bank account (simulated)';

  if (g.status !== 'active') {
    return (
      <div className="narrow">
        <PageHeader title={copy.title} back={{ to: `/goals/${g.id}`, label: g.name }} />
        <Notice tone="info">This goal is archived. Restore it first.</Notice>
      </div>
    );
  }
  if (kind === 'withdrawal' && available === 0 && step === 'amount') {
    return (
      <div className="narrow">
        <PageHeader title={copy.title} back={{ to: `/goals/${g.id}`, label: g.name }} />
        <Notice tone="info" title="Nothing to withdraw right now">
          {g.balance.pendingOutPaise > 0
            ? 'A withdrawal is already waiting for confirmation.'
            : 'This goal has no confirmed balance yet.'}
        </Notice>
      </div>
    );
  }

  const continueToReview = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseRupeesToPaise(amountText, { maxPaise: maxPaise ?? undefined });
    if (!parsed.ok) {
      setAmountError(kind === 'withdrawal' && parsed.error.startsWith('The maximum') ? `You can withdraw up to ${formatINR(available)} from this goal.` : parsed.error);
      document.getElementById('amount')?.focus();
      return;
    }
    setAmountError(null);
    if (parsed.paise !== amountPaise) idempotencyKey.current = newIdempotencyKey();
    setAmountPaise(parsed.paise);
    setStep('review');
  };

  const fromLabel = kind === 'contribution' ? bankLabel : `${g.icon} ${g.name} (goal pocket)`;
  const toLabel = kind === 'contribution' ? `${g.icon} ${g.name} (goal pocket)` : bankLabel;

  return (
    <div className="narrow">
      <PageHeader title={copy.title} back={{ to: `/goals/${g.id}`, label: g.name }} />
      <ol className="steps" aria-label="Progress">
        <li data-done="true"><span className="sr-only">Amount{step === 'amount' ? ' (current step)' : ''}</span></li>
        <li data-done={step !== 'amount'}><span className="sr-only">Review{step === 'review' ? ' (current step)' : ''}</span></li>
        <li data-done={step === 'status'}><span className="sr-only">Status{step === 'status' ? ' (current step)' : ''}</span></li>
      </ol>

      {step === 'amount' ? (
        <form className="card stack" onSubmit={continueToReview} noValidate>
          <h2 ref={headingRef} tabIndex={-1}>
            How much would you like to {copy.verb}?
          </h2>
          {kind === 'withdrawal' ? (
            <p className="small" style={{ margin: 0 }}>
              Available in {g.name}: <strong className="num">{formatINR(available)}</strong> <SimChip />
              {g.balance.pendingOutPaise ? <span className="muted"> ({formatINR(g.balance.pendingOutPaise)} is held for a pending withdrawal)</span> : null}
            </p>
          ) : null}
          <div className="field">
            <label htmlFor="amount">Amount in rupees</label>
            <div className="input-prefix">
              <span className="big">₹</span>
              <input
                id="amount"
                className="input input--amount num"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                aria-invalid={Boolean(amountError)}
                aria-describedby={amountError ? 'amount-error' : 'amount-hint'}
              />
            </div>
            {amountError ? (
              <span id="amount-error" className="field-error" role="alert">{amountError}</span>
            ) : (
              <span id="amount-hint" className="hint">Fixed amount, between ₹1 and {formatINR(maxPaise ?? 0)}.</span>
            )}
          </div>
          <div className="chips" role="group" aria-label="Quick amounts">
            {PRESETS.filter((p) => kind === 'contribution' || p <= available).map((p) => (
              <button key={p} type="button" className="choice-chip num" aria-pressed={amountText === paiseToInputValue(p)} onClick={() => setAmountText(paiseToInputValue(p))}>
                {formatINR(p)}
              </button>
            ))}
            {kind === 'withdrawal' ? (
              <button type="button" className="choice-chip" onClick={() => setAmountText(paiseToInputValue(available))}>
                Full amount
              </button>
            ) : null}
          </div>
          <div className="btn-row btn-row--end btn-row--stack">
            <button type="button" className="btn btn--ghost" onClick={() => navigate(-1)}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary">
              Review <Icon name="arrowRight" size={18} />
            </button>
          </div>
        </form>
      ) : null}

      {step === 'review' ? (
        <section className="card review" aria-labelledby="review-title">
          <h2 id="review-title" ref={headingRef} tabIndex={-1}>
            Check the details
          </h2>
          <div className="review__amount">
            <div className="big num">{formatINR(amountPaise, { paise: 'always' })}</div>
            <div className="review__words">{amountInWords(amountPaise)}</div>
          </div>
          <div className="flow" aria-label="Money flow">
            <div className="flow__box">
              <span className="muted">From</span>
              <strong>{fromLabel}</strong>
            </div>
            <span className="flow__arrow" aria-hidden="true">
              <Icon name="arrowRight" />
            </span>
            <div className="flow__box">
              <span className="muted">To</span>
              <strong>{toLabel}</strong>
            </div>
          </div>
          <Notice tone="demo" title="This demo transaction does not move money">
            <p>
              {kind === 'contribution'
                ? 'Nothing will be taken from any bank account. A simulated partner bank will confirm it in a few seconds, and only then will the goal balance change.'
                : 'Nothing will be sent to any bank account. A simulated partner bank will confirm it in a few seconds; the amount is held until then.'}
            </p>
            <p>No fees. No lock-in period.</p>
          </Notice>
          <details className="disclosure">
            <summary>Demo testing options</summary>
            <fieldset>
              <legend className="small">How should the simulated partner respond?</legend>
              <div className="radio-cards">
                {(
                  [
                    ['confirm', 'Confirms', 'Normal outcome'],
                    ['decline', 'Declines', 'See a failed state'],
                    ['slow', 'Is slow', 'Stays pending'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label key={value} className="radio-card">
                    <input type="radio" name="scenario" value={value} checked={scenario === value} onChange={() => setScenario(value)} />
                    <span>
                      {label}
                      <small>{hint}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </details>
          {submit.isError ? (
            <Notice tone="error" title="Not submitted">
              <p>{errorMessage(submit.error)}</p>
            </Notice>
          ) : null}
          <div className="btn-row btn-row--end btn-row--stack">
            <button type="button" className="btn btn--ghost" onClick={() => setStep('amount')} disabled={submit.isPending}>
              Change amount
            </button>
            <button type="button" className="btn btn--primary" onClick={() => submit.mutate()} disabled={submit.isPending}>
              {submit.isPending ? 'Submitting…' : copy.confirm}
            </button>
          </div>
        </section>
      ) : null}

      {step === 'status' && transactionId ? (
        <TransferStatus transactionId={transactionId} kind={kind} goalId={g.id} goalName={g.name} headingRef={headingRef} onSettled={refresh} />
      ) : null}
    </div>
  );
}

function TransferStatus({
  transactionId,
  kind,
  goalId,
  goalName,
  headingRef,
  onSettled,
}: {
  transactionId: string;
  kind: TxnKind;
  goalId: string;
  goalName: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onSettled: () => void;
}) {
  const txn = useTransaction(transactionId);
  const [slow, setSlow] = useState(false);
  const refreshedFor = useRef<string | null>(null);
  const status = txn.data?.status;

  useEffect(() => {
    const id = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    // Refresh balances once when the partner's final answer arrives.
    if (status && status !== 'pending' && refreshedFor.current !== status) {
      refreshedFor.current = status;
      onSettled();
    }
  }, [status, onSettled]);

  if (txn.isPending) return <LoadingBlock lines={1} />;
  if (txn.isError) return <ErrorState error={txn.error} onRetry={() => txn.refetch()} />;
  const t = txn.data;

  return (
    <section className="card status-panel" aria-live="polite">
      {t.status === 'pending' ? (
        <>
          <span className="status-icon status-icon--pending">
            <span className="spinner" aria-hidden="true" />
          </span>
          <h2 ref={headingRef} tabIndex={-1}>
            Waiting for confirmation
          </h2>
          <p className="muted" style={{ maxWidth: '40ch' }}>
            The simulated partner bank hasn’t confirmed this yet. This is <strong>not complete</strong>, and the goal balance will change only after
            confirmation.
          </p>
          {slow ? <Notice tone="info">This is taking longer than usual. You can leave this page — the status will update in Activity.</Notice> : null}
        </>
      ) : t.status === 'completed' ? (
        <>
          <span className="status-icon status-icon--ok">
            <Icon name="check" />
          </span>
          <h2 ref={headingRef} tabIndex={-1}>
            {COPY[kind].doneTitle}
          </h2>
          <p style={{ maxWidth: '40ch' }}>
            <strong className="num">{formatINR(t.amountPaise)}</strong> {kind === 'contribution' ? `is now allocated to ${goalName}` : `was withdrawn from ${goalName}`} in
            the demo. <strong>No real money moved.</strong>
          </p>
        </>
      ) : (
        <>
          <span className="status-icon status-icon--bad">
            <Icon name="x" />
          </span>
          <h2 ref={headingRef} tabIndex={-1}>
            Not completed
          </h2>
          <p style={{ maxWidth: '40ch' }}>{t.failureReason ?? 'The simulated partner did not complete this.'} Your goal balance has not changed.</p>
        </>
      )}
      <div className="row" style={{ justifyContent: 'center' }}>
        <TxnStatusBadge status={t.status} />
        <SimChip />
      </div>
      <div className="btn-row" style={{ justifyContent: 'center' }}>
        <Link to={`/goals/${goalId}`} className="btn btn--primary">
          Back to goal
        </Link>
        <Link to={`/activity/${t.id}`} className="btn btn--secondary">
          View details
        </Link>
      </div>
    </section>
  );
}

/** /add and /withdraw without a goal: pick one first. */
export function ChooseGoalPage({ kind }: { kind: TxnKind }) {
  const dashboard = useDashboard();
  const title = kind === 'contribution' ? 'Add savings' : 'Withdraw';
  if (dashboard.isPending) return <LoadingBlock />;
  if (dashboard.isError) return <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />;
  const goals = dashboard.data.goals.filter((g) => kind === 'contribution' || g.balance.availablePaise > 0);
  return (
    <div className="narrow">
      <PageHeader title={title} description="Choose a goal." back={{ to: '/', label: 'Home' }} />
      {goals.length === 0 ? (
        <Notice tone="info" title={kind === 'contribution' ? 'No goals yet' : 'Nothing to withdraw'}>
          {kind === 'contribution' ? <Link to="/goals/new">Create a goal first</Link> : 'None of your goals has a confirmed balance yet.'}
        </Notice>
      ) : (
        <ul className="list card">
          {goals.map((g) => (
            <li key={g.id}>
              <Link to={`/goals/${g.id}/${kind === 'contribution' ? 'add' : 'withdraw'}`} className="list-item">
                <span className="goal-icon" aria-hidden="true">
                  {g.icon}
                </span>
                <span className="list-item__body">
                  <span className="list-item__title">{g.name}</span>
                  <span className="list-item__meta">
                    {kind === 'contribution' ? `${formatINR(g.balance.postedPaise)} of ${formatINR(g.targetPaise)}` : `${formatINR(g.balance.availablePaise)} available`}
                  </span>
                </span>
                <Icon name="arrowRight" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
