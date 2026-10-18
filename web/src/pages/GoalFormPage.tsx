import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { todayInIST } from '../../../shared/dates';
import { MAX_TARGET_PAISE, paiseToInputValue, parseRupeesToPaise } from '../../../shared/money';
import { GOAL_ICONS, type GoalDTO } from '../../../shared/types';
import { ConfirmDialog, ErrorState, LoadingBlock, Notice, PageHeader } from '../components/ui';
import { api, errorMessage, errorReasons, newIdempotencyKey } from '../lib/api';
import { useGoal, useRefreshMoney } from '../lib/queries';

const SUGGESTIONS: Array<{ name: string; icon: (typeof GOAL_ICONS)[number] }> = [
  { name: 'Emergency fund', icon: '🛟' },
  { name: 'Rent', icon: '🏠' },
  { name: 'New phone', icon: '📱' },
  { name: 'Education', icon: '🎓' },
  { name: 'Travel', icon: '✈️' },
  { name: 'Festival', icon: '🪔' },
];

const ICON_LABELS: Record<string, string> = {
  '🛟': 'Safety ring', '🏠': 'Home', '📱': 'Phone', '🎓': 'Education', '✈️': 'Travel', '🪔': 'Festival lamp',
  '🎁': 'Gift', '🏍️': 'Motorbike', '💍': 'Wedding', '🩺': 'Health', '💻': 'Laptop', '🫙': 'Jar',
};

export function GoalFormPage() {
  const { goalId } = useParams();
  const editing = Boolean(goalId);
  const goal = useGoal(goalId);
  if (editing && goal.isPending) return <LoadingBlock />;
  if (editing && goal.isError) return <ErrorState error={goal.error} onRetry={() => goal.refetch()} />;
  return <GoalForm goal={goal.data} />;
}

function GoalForm({ goal }: { goal?: GoalDTO & { archiveBlockers: string[] } }) {
  const navigate = useNavigate();
  const refresh = useRefreshMoney();
  const [name, setName] = useState(goal?.name ?? '');
  const [icon, setIcon] = useState<string>(goal?.icon ?? '🛟');
  const [target, setTarget] = useState(goal ? paiseToInputValue(goal.targetPaise) : '');
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [errors, setErrors] = useState<{ name?: string; target?: string }>({});
  const [archiveOpen, setArchiveOpen] = useState(false);
  const idempotencyKey = useRef(newIdempotencyKey());
  const today = todayInIST(new Date());

  const save = useMutation({
    mutationFn: (body: { name: string; icon: string; targetPaise: number; targetDate: string | null }) =>
      goal
        ? api<GoalDTO>(`/api/goals/${goal.id}`, { method: 'PATCH', body })
        : api<GoalDTO>('/api/goals', { method: 'POST', body, idempotencyKey: idempotencyKey.current }),
    onSuccess: async (saved) => {
      await refresh();
      navigate(`/goals/${saved.id}`, { replace: true });
    },
  });

  const archive = useMutation({
    mutationFn: () => api<GoalDTO>(`/api/goals/${goal!.id}/archive`, { method: 'POST' }),
    onSuccess: async () => {
      await refresh();
      navigate('/goals', { replace: true });
    },
  });

  useEffect(() => {
    if (!save.isError) return;
    document.getElementById('form-error')?.focus();
  }, [save.isError]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!name.trim()) next.name = 'Give your goal a name.';
    const parsed = parseRupeesToPaise(target, { maxPaise: MAX_TARGET_PAISE });
    if (!parsed.ok) next.target = parsed.error;
    setErrors(next);
    if (next.name || !parsed.ok) {
      document.getElementById(next.name ? 'goal-name' : 'goal-target')?.focus();
      return;
    }
    save.mutate({ name: name.trim(), icon, targetPaise: parsed.paise, targetDate: targetDate || null });
  };

  return (
    <div className="narrow">
      <PageHeader
        title={goal ? 'Edit goal' : 'New goal'}
        back={goal ? { to: `/goals/${goal.id}`, label: goal.name } : { to: '/goals', label: 'Goals' }}
        description={goal ? undefined : 'A goal is a pocket inside the app. It shows how much of your savings is set aside for one purpose.'}
      />
      <form className="card stack" onSubmit={submit} noValidate>
        {save.isError ? (
          <div id="form-error" tabIndex={-1}>
            <Notice tone="error">{errorMessage(save.error)}</Notice>
          </div>
        ) : null}

        {!goal ? (
          <div className="field">
            <span className="label" id="suggestions-label">
              Ideas
            </span>
            <div className="chips" role="group" aria-labelledby="suggestions-label">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  className="choice-chip"
                  aria-pressed={name === s.name}
                  onClick={() => {
                    setName(s.name);
                    setIcon(s.icon);
                  }}
                >
                  {s.icon} {s.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="goal-name">Goal name</label>
          <input
            id="goal-name"
            className="input"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? 'goal-name-error' : undefined}
          />
          {errors.name ? <span id="goal-name-error" className="field-error">{errors.name}</span> : null}
        </div>

        <fieldset>
          <legend>Icon</legend>
          <div className="icon-picker">
            {GOAL_ICONS.map((value) => (
              <label key={value} className="radio-card">
                <input type="radio" name="icon" value={value} checked={icon === value} onChange={() => setIcon(value)} aria-label={ICON_LABELS[value]} />
                <span aria-hidden="true">{value}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="goal-target">Target amount</label>
          <div className="input-prefix">
            <span>₹</span>
            <input
              id="goal-target"
              className="input num"
              inputMode="decimal"
              placeholder="25,000"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-invalid={Boolean(errors.target)}
              aria-describedby={errors.target ? 'goal-target-error' : 'goal-target-hint'}
            />
          </div>
          {errors.target ? (
            <span id="goal-target-error" className="field-error">{errors.target}</span>
          ) : (
            <span id="goal-target-hint" className="hint">In rupees. You can change this later.</span>
          )}
        </div>

        <div className="field">
          <label htmlFor="goal-date">Target date (optional)</label>
          <input id="goal-date" className="input" type="date" min={today} value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          <span className="hint">Helps us suggest a steady monthly amount. No deadline pressure — you can save at your own pace.</span>
        </div>

        <div className="btn-row btn-row--end btn-row--stack">
          <button type="button" className="btn btn--ghost" onClick={() => navigate(-1)}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : goal ? 'Save changes' : 'Create goal'}
          </button>
        </div>
      </form>

      {goal ? (
        <section className="card card--flat stack" style={{ marginTop: 20 }} aria-labelledby="archive-title">
          <h2 id="archive-title">Archive this goal</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Archiving hides the goal but keeps its full history. You can restore it later.
          </p>
          {goal.archiveBlockers.length ? (
            <Notice tone="warn" title="This goal can’t be archived yet">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {goal.archiveBlockers.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <div>
            <button type="button" className="btn btn--danger-outline" disabled={goal.archiveBlockers.length > 0} onClick={() => setArchiveOpen(true)}>
              Archive goal
            </button>
          </div>
        </section>
      ) : null}

      {goal ? (
        <ConfirmDialog
          open={archiveOpen}
          title={`Archive “${goal.name}”?`}
          confirmLabel="Archive goal"
          tone="danger"
          busy={archive.isPending}
          onCancel={() => setArchiveOpen(false)}
          onConfirm={() => archive.mutate()}
        >
          <p style={{ margin: 0 }}>The goal and its history will be kept. You can restore it from the Archived tab.</p>
          {archive.isError ? (
            <Notice tone="error">
              {errorMessage(archive.error)}
              {errorReasons(archive.error).map((r) => (
                <p key={r}>{r}</p>
              ))}
            </Notice>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
