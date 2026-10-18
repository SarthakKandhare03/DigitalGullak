import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { addDays, anchorFor, describeFrequency, formatDateIN, isISODate, todayInIST, upcomingOccurrences, type Frequency } from '../../../shared/dates';
import { MAX_SCHEDULE_PAISE, formatINR, parseRupeesToPaise } from '../../../shared/money';
import type { ScheduleDTO } from '../../../shared/types';
import { DemoNotice, ErrorState, LoadingBlock, Notice, PageHeader } from '../components/ui';
import { api, errorMessage, newIdempotencyKey } from '../lib/api';
import { useGoals, useRefreshMoney } from '../lib/queries';

export function NewSchedulePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const goals = useGoals('active');
  const refresh = useRefreshMoney();
  const today = todayInIST(new Date());
  const [goalId, setGoalId] = useState(params.get('goalId') ?? '');
  const [amountText, setAmountText] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [startDate, setStartDate] = useState(addDays(today, 1));
  const [consent, setConsent] = useState(false); // never preselected
  const [errors, setErrors] = useState<{ goal?: string; amount?: string; date?: string; consent?: string }>({});
  const idempotencyKey = useRef(newIdempotencyKey());

  const create = useMutation({
    mutationFn: (body: { goalId: string; amountPaise: number; frequency: Frequency; startDate: string; consent: boolean }) =>
      api<ScheduleDTO>('/api/schedules', { method: 'POST', body, idempotencyKey: idempotencyKey.current }),
    onSuccess: async () => {
      await refresh();
      navigate('/schedules', { replace: true });
    },
  });

  if (goals.isPending) return <LoadingBlock />;
  if (goals.isError) return <ErrorState error={goals.error} onRetry={() => goals.refetch()} />;
  if (goals.data.length === 0) {
    return (
      <div className="narrow">
        <PageHeader title="New schedule" back={{ to: '/schedules', label: 'Schedules' }} />
        <Notice tone="info" title="Create a goal first">
          <Link to="/goals/new">Create a goal</Link> — schedules always save toward a goal.
        </Notice>
      </div>
    );
  }

  const parsed = parseRupeesToPaise(amountText, { maxPaise: MAX_SCHEDULE_PAISE });
  const validDate = isISODate(startDate) && startDate >= today;
  const anchor = validDate ? anchorFor(frequency, startDate) : null;
  const preview = validDate ? upcomingOccurrences(frequency, anchor, startDate, startDate, 3) : [];
  const goal = goals.data.find((g) => g.id === goalId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!goal) next.goal = 'Choose a goal.';
    if (!parsed.ok) next.amount = parsed.error;
    if (!validDate) next.date = 'Choose a start date from today onwards.';
    if (!consent) next.consent = 'Please confirm you understand how this simulated schedule works.';
    setErrors(next);
    const firstInvalid = next.goal ? 'sched-goal' : next.amount ? 'sched-amount' : next.date ? 'sched-date' : next.consent ? 'sched-consent' : null;
    if (firstInvalid || !parsed.ok) {
      document.getElementById(firstInvalid ?? 'sched-amount')?.focus();
      return;
    }
    create.mutate({ goalId, amountPaise: parsed.paise, frequency, startDate, consent });
  };

  return (
    <div className="narrow">
      <PageHeader title="New savings schedule" back={{ to: '/schedules', label: 'Schedules' }} />
      <form className="card stack" onSubmit={submit} noValidate>
        <DemoNotice>
          <p>This creates a simulated schedule. <strong>No automatic debit will occur</strong> and no mandate is created.</p>
        </DemoNotice>

        <div className="field">
          <label htmlFor="sched-goal">Goal</label>
          <select id="sched-goal" className="select" value={goalId} onChange={(e) => setGoalId(e.target.value)} aria-invalid={Boolean(errors.goal)}>
            <option value="">Choose a goal…</option>
            {goals.data.map((g) => (
              <option key={g.id} value={g.id}>
                {g.icon} {g.name}
              </option>
            ))}
          </select>
          {errors.goal ? <span className="field-error">{errors.goal}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="sched-amount">Amount each time</label>
          <div className="input-prefix">
            <span>₹</span>
            <input
              id="sched-amount"
              className="input num"
              inputMode="decimal"
              placeholder="500"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              aria-invalid={Boolean(errors.amount)}
              aria-describedby="sched-amount-hint"
            />
          </div>
          {errors.amount ? (
            <span className="field-error">{errors.amount}</span>
          ) : (
            <span id="sched-amount-hint" className="hint">
              Up to {formatINR(MAX_SCHEDULE_PAISE)} per run — in line with the usual limit for recurring debits without extra authentication.
            </span>
          )}
        </div>

        <fieldset>
          <legend>How often?</legend>
          <div className="radio-cards">
            {(
              [
                ['daily', 'Daily', 'Every day'],
                ['weekly', 'Weekly', 'Same weekday'],
                ['monthly', 'Monthly', 'Same date'],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="radio-card">
                <input type="radio" name="frequency" value={value} checked={frequency === value} onChange={() => setFrequency(value)} />
                <span>
                  {label}
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="sched-date">First date</label>
          <input id="sched-date" className="input" type="date" min={today} max={addDays(today, 365)} value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-invalid={Boolean(errors.date)} />
          {errors.date ? <span className="field-error">{errors.date}</span> : null}
        </div>

        {parsed.ok && validDate && goal ? (
          <section className="card card--tint" aria-label="Summary" aria-live="polite">
            <p style={{ margin: '0 0 6px' }}>
              <strong className="num">{formatINR(parsed.paise)}</strong> {describeFrequency(frequency, anchor)} to <strong>{goal.name}</strong>, starting{' '}
              {formatDateIN(startDate)}.
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              Next simulated dates: {preview.map(formatDateIN).join(', ')}
            </p>
          </section>
        ) : null}

        <label className="check" htmlFor="sched-consent">
          <input id="sched-consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-invalid={Boolean(errors.consent)} />
          <span>
            I understand this schedule is <strong>simulated</strong>: no money will be debited and no mandate is created. In a real version I would
            approve a mandate with my bank, get a notice at least 24 hours before each debit, and could pause or cancel at any time.
          </span>
        </label>
        {errors.consent ? <span className="field-error">{errors.consent}</span> : null}

        {create.isError ? <Notice tone="error">{errorMessage(create.error)}</Notice> : null}

        <div className="btn-row btn-row--end btn-row--stack">
          <button type="button" className="btn btn--ghost" onClick={() => navigate(-1)}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create simulated schedule'}
          </button>
        </div>
      </form>
    </div>
  );
}
