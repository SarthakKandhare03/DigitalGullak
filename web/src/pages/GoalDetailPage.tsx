import { Link, useParams } from 'react-router';
import { describeFrequency, formatDateIN, monthsUntil, todayInIST } from '../../../shared/dates';
import { ceilDiv, formatINR, progressPercent } from '../../../shared/money';
import { ActivityList } from '../components/ActivityList';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingBlock, Money, Notice, PageHeader, Progress, ScheduleStatusBadge, SimChip } from '../components/ui';
import { useActivity, useGoal, useSchedules } from '../lib/queries';

export function GoalDetailPage() {
  const { goalId } = useParams();
  const goal = useGoal(goalId);
  const activity = useActivity({ goalId }, 10);
  const schedules = useSchedules();

  if (goal.isPending) return <LoadingBlock />;
  if (goal.isError) return <ErrorState error={goal.error} onRetry={() => goal.refetch()} />;

  const g = goal.data;
  const saved = g.balance.postedPaise;
  const remaining = Math.max(0, g.targetPaise - saved);
  const pct = progressPercent(saved, g.targetPaise);
  const today = todayInIST(new Date());
  let suggestion: string | null = null;
  if (g.targetDate && remaining > 0 && g.targetDate > today) {
    const months = monthsUntil(today, g.targetDate);
    const perMonth = ceilDiv(ceilDiv(remaining, months), 100) * 100; // round up to whole rupees
    suggestion = `About ${formatINR(perMonth)} a month would reach this by ${formatDateIN(g.targetDate)}.`;
  }
  const goalSchedules = (schedules.data ?? []).filter((s) => s.goalId === g.id && s.status !== 'cancelled');
  const items = activity.data?.pages.flatMap((p) => p.items) ?? [];
  const archived = g.status === 'archived';

  return (
    <div className="stack-lg">
      <PageHeader
        title={g.name}
        back={{ to: '/goals', label: 'Goals' }}
        actions={
          !archived ? (
            <Link to={`/goals/${g.id}/edit`} className="btn btn--ghost btn--small">
              <Icon name="edit" size={16} /> Edit
            </Link>
          ) : undefined
        }
      />

      {archived ? <Notice tone="info">This goal is archived. Restore it from the Goals page to add savings again.</Notice> : null}

      <section className="card stack" aria-label="Progress">
        <div className="row">
          <span className="goal-icon goal-icon--lg" aria-hidden="true">
            {g.icon}
          </span>
          <div>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontSize: '2rem', fontWeight: 750 }} className="num">
                {formatINR(saved)}
              </span>
              <SimChip />
              {g.isExample ? <span className="chip chip--sample">Example</span> : null}
            </div>
            <div className="muted">
              saved of {formatINR(g.targetPaise)} · {pct}%
            </div>
          </div>
        </div>
        <Progress saved={saved} target={g.targetPaise} large label={`${g.name} progress`} />
        <dl className="stat-grid">
          <div className="stat">
            <dt>Available to withdraw</dt>
            <dd>
              <Money paise={g.balance.availablePaise} />
            </dd>
          </div>
          <div className="stat">
            <dt>Still to go</dt>
            <dd>
              <Money paise={remaining} />
            </dd>
          </div>
          <div className="stat">
            <dt>Waiting to confirm</dt>
            <dd>
              {g.balance.pendingInPaise || g.balance.pendingOutPaise ? (
                <>
                  {g.balance.pendingInPaise ? <span className="num">+{formatINR(g.balance.pendingInPaise)} </span> : null}
                  {g.balance.pendingOutPaise ? <span className="num">−{formatINR(g.balance.pendingOutPaise)}</span> : null}
                </>
              ) : (
                'None'
              )}
            </dd>
          </div>
          <div className="stat">
            <dt>Target date</dt>
            <dd>{g.targetDate ? formatDateIN(g.targetDate) : 'Not set'}</dd>
          </div>
        </dl>
        {saved >= g.targetPaise ? <Notice tone="ok" title="Goal reached">You’ve reached this goal’s target (in the demo).</Notice> : null}
        {suggestion ? <p className="small muted" style={{ margin: 0 }}>{suggestion}</p> : null}
        {!archived ? (
          <div className="btn-row">
            <Link to={`/goals/${g.id}/add`} className="btn btn--primary">
              <Icon name="plus" /> Add savings
            </Link>
            <Link
              to={`/goals/${g.id}/withdraw`}
              className="btn btn--secondary"
              aria-disabled={g.balance.availablePaise === 0}
              onClick={(e) => g.balance.availablePaise === 0 && e.preventDefault()}
            >
              Withdraw
            </Link>
            <Link to={`/schedules/new?goalId=${g.id}`} className="btn btn--ghost">
              <Icon name="repeat" /> Set up a schedule
            </Link>
          </div>
        ) : null}
      </section>

      {goalSchedules.length ? (
        <section aria-labelledby="goal-sched">
          <div className="section-title">
            <h2 id="goal-sched">Schedules for this goal</h2>
            <Link to="/schedules">Manage</Link>
          </div>
          <ul className="list card">
            {goalSchedules.map((s) => (
              <li key={s.id} className="list-item">
                <span className="list-item__body">
                  <span className="list-item__title">
                    <Money paise={s.amountPaise} /> {describeFrequency(s.frequency, s.anchor)}
                  </span>
                  <span className="list-item__meta">{s.status === 'active' && s.nextRunDate ? `Next simulated date ${formatDateIN(s.nextRunDate)}` : 'Paused'}</span>
                </span>
                <ScheduleStatusBadge status={s.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="goal-activity">
        <div className="section-title">
          <h2 id="goal-activity">Activity</h2>
        </div>
        <div className="card">
          {activity.isPending ? (
            <LoadingBlock lines={2} />
          ) : activity.isError ? (
            <ErrorState error={activity.error} onRetry={() => activity.refetch()} />
          ) : items.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No activity for this goal yet.</p>
          ) : (
            <ActivityList items={items} />
          )}
        </div>
      </section>
    </div>
  );
}
