import { Link } from 'react-router';
import { describeFrequency, formatDateIN } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import { ActivityList } from '../components/ActivityList';
import { GoalCard } from '../components/GoalCard';
import { GullakArt } from '../components/Gullak';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingBlock, Money, ScheduleStatusBadge, SimChip, useDocumentTitle } from '../components/ui';
import { SavingsChart } from '../components/SavingsChart';
import { useCountUp } from '../lib/motion';
import { useDashboard, useMe, useRewards } from '../lib/queries';

/** Next quest and quick game links — habit nudges, never pressure. */
function RewardsTeaser() {
  const rewards = useRewards();
  const quest = rewards.data?.quests.find((q) => q.status !== 'claimed');
  return (
    <section className="card stack" aria-labelledby="teaser-title">
      <div className="row-between">
        <h2 id="teaser-title" style={{ margin: 0 }}>
          Rewards
        </h2>
        <Link to="/rewards" className="small" style={{ fontWeight: 600, textDecoration: 'none' }}>
          Open
        </Link>
      </div>
      {quest ? (
        <Link to="/rewards" className="list-item" style={{ padding: '6px 0' }}>
          <span className="list-item__icon list-item__icon--reward">
            <Icon name="trophy" />
          </span>
          <span className="list-item__body">
            <span className="list-item__title">{quest.title}</span>
            <span className="list-item__meta">
              {quest.unit === 'paise' ? `${formatINR(quest.progress)} of ${formatINR(quest.target)}` : `${quest.progress} of ${quest.target}`} · +{quest.points} pts
            </span>
          </span>
          {quest.status === 'claimable' ? <span className="chip chip--gold">Claim</span> : null}
        </Link>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          All quests done this week. Nice work!
        </p>
      )}
      <div className="btn-row">
        <Link to="/rewards/coin-catch" className="btn btn--secondary btn--small">
          🪙 Coin Catch
        </Link>
        <Link to="/rewards/quiz" className="btn btn--secondary btn--small">
          🧠 Money Quiz
        </Link>
      </div>
    </section>
  );
}

export function HomePage() {
  useDocumentTitle('Home');
  const me = useMe();
  const dashboard = useDashboard();
  const rewards = useRewards();
  const animatedTotal = useCountUp(dashboard.data?.totals.postedPaise ?? 0);

  if (dashboard.isPending) return <LoadingBlock label="Loading your savings" />;
  if (dashboard.isError) return <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />;

  const { totals, goals, schedules, recentActivity, partner } = dashboard.data;
  const pendingIn = totals.pendingInPaise;
  const pendingOut = totals.pendingOutPaise;
  const name = me.data?.displayName;

  return (
    <div className="stack-lg">
      <h1 tabIndex={-1} data-page-heading className="sr-only">
        Home
      </h1>
      <section className="card hero" aria-labelledby="total-label">
        <GullakArt className="hero__art" />
        <div className="hero__label" id="total-label">
          <span className="hero__live" aria-hidden="true" />
          {name ? `Namaste, ${name} · ` : ''}Total saved <SimChip />
        </div>
        <div className="hero__amount num" aria-hidden="true">
          {formatINR(animatedTotal)}
        </div>
        <span className="sr-only">{formatINR(totals.postedPaise)}</span>
        <p className="hero__sub">
          {goals.length === 0
            ? 'Create a goal to start saving.'
            : `Across ${goals.length} goal${goals.length > 1 ? 's' : ''}. Demo balance — no real money is held.`}
        </p>
        {pendingIn > 0 || pendingOut > 0 ? (
          <p className="hero__sub" style={{ marginTop: 6 }}>
            <Icon name="clock" size={14} /> Waiting for confirmation:{' '}
            {pendingIn > 0 ? `+${formatINR(pendingIn)} in` : ''}
            {pendingIn > 0 && pendingOut > 0 ? ', ' : ''}
            {pendingOut > 0 ? `−${formatINR(pendingOut)} out` : ''}
          </p>
        ) : null}
        <div className="hero__actions">
          <Link to="/add" className="btn btn--primary">
            <Icon name="plus" /> Add savings
          </Link>
          <Link to="/withdraw" className="btn btn--secondary">
            Withdraw
          </Link>
        </div>
        {rewards.data ? (
          <div className="hero__stats">
            <Link to="/rewards" className="hero__stat">
              <span aria-hidden="true">🪙</span> {rewards.data.points.balance.toLocaleString('en-IN')} points
            </Link>
            <Link to="/rewards" className="hero__stat">
              <span aria-hidden="true">🔥</span> {rewards.data.streak.weeks}-week streak
            </Link>
            <Link to="/rewards" className="hero__stat">
              <span aria-hidden="true">🏅</span> {rewards.data.level.name}
            </Link>
          </div>
        ) : null}
      </section>

      <div className="grid-2 stagger">
        <SavingsChart />
        <RewardsTeaser />
      </div>

      <div className="grid-2">
        <div className="stack-lg">
          <section aria-labelledby="goals-title">
            <div className="section-title">
              <h2 id="goals-title">Your goals</h2>
              <Link to="/goals">See all</Link>
            </div>
            {goals.length === 0 ? (
              <EmptyState
                title="No goals yet"
                action={
                  <Link to="/goals/new" className="btn btn--primary">
                    Create your first goal
                  </Link>
                }
              >
                A goal is a pocket for one purpose, like an emergency fund or a new phone.
              </EmptyState>
            ) : (
              <div className="grid-goals">
                {goals.slice(0, 4).map((goal) => (
                  <GoalCard key={goal.id} goal={goal} />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="activity-title">
            <div className="section-title">
              <h2 id="activity-title">Recent activity</h2>
              <Link to="/activity">See all</Link>
            </div>
            <div className="card">
              {recentActivity.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  Nothing yet. Your simulated savings and withdrawals will appear here.
                </p>
              ) : (
                <ActivityList items={recentActivity} grouped={false} />
              )}
            </div>
          </section>
        </div>

        <div className="stack-lg">
          <section aria-labelledby="schedules-title">
            <div className="section-title">
              <h2 id="schedules-title">Savings schedules</h2>
              <Link to="/schedules">Manage</Link>
            </div>
            <div className="card stack">
              {schedules.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No schedules. <Link to="/schedules/new">Set up a simulated schedule</Link>
                </p>
              ) : (
                <ul className="list">
                  {schedules.map((s) => (
                    <li key={s.id}>
                      <Link to="/schedules" className="list-item">
                        <span className="goal-icon" aria-hidden="true">
                          {s.goalIcon}
                        </span>
                        <span className="list-item__body">
                          <span className="list-item__title">
                            <Money paise={s.amountPaise} /> {describeFrequency(s.frequency, s.anchor)}
                          </span>
                          <span className="list-item__meta">
                            {s.goalName} · {s.status === 'active' && s.nextRunDate ? `Next ${formatDateIN(s.nextRunDate)}` : 'Paused'}
                          </span>
                        </span>
                        <ScheduleStatusBadge status={s.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="tiny muted" style={{ margin: 0 }}>
                Simulation only — no automatic debit happens in demo mode.
              </p>
            </div>
          </section>

          <section className="card card--tint stack" aria-labelledby="partner-title">
            <h2 id="partner-title">Where your money would be held</h2>
            <p className="small" style={{ margin: 0 }}>
              <strong>In this demo: nowhere.</strong> Balances are simulated. In the live product, savings would sit in your own account with a
              regulated partner bank, and the partner’s records would be final.
            </p>
            <dl className="kv small">
              <dt>Partner</dt>
              <dd>{partner.partnerDisplayName}</dd>
              <dt>Account</dt>
              <dd>{partner.maskedAccountNumber ?? 'Not opened'}</dd>
              <dt>Interest</dt>
              <dd>
                {partner.interest
                  ? partner.interest.annualRateText
                  : 'Not shown. We only show interest when a partner bank supplies real terms.'}
              </dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
