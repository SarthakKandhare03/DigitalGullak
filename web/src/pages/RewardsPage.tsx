import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatDateIN, formatDateTimeIN } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import { pointsToPaise, type QuestDTO, type RewardsSummaryDTO } from '../../../shared/rewards';
import type { CreateTransferResponse } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toaster';
import { DemoNotice, ErrorState, LoadingBlock, Notice, PageHeader, SimChip } from '../components/ui';
import { api, errorMessage, newIdempotencyKey } from '../lib/api';
import { burstConfetti, useCountUp } from '../lib/motion';
import { useGoals, useRefreshMoney, useRewards } from '../lib/queries';

const LEVEL_ICONS = ['🥉', '🥈', '🥇', '💎', '👑'];

function QuestRing({ quest }: { quest: QuestDTO }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const pct = quest.target ? quest.progress / quest.target : 0;
  return (
    <svg className="quest__ring" viewBox="0 0 52 52" aria-hidden="true">
      <circle className="bg" cx="26" cy="26" r={r} />
      <circle className="fg" cx="26" cy="26" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 26 26)" />
      <text x="26" y="30" textAnchor="middle" fontSize="12" fontWeight="800" fill="var(--gold-1)">
        {quest.status === 'claimed' ? '✓' : `${Math.round(pct * 100)}%`}
      </text>
    </svg>
  );
}

function progressText(q: QuestDTO): string {
  return q.unit === 'paise' ? `${formatINR(q.progress)} of ${formatINR(q.target)}` : `${q.progress} of ${q.target}`;
}

export function RewardsPage() {
  const rewards = useRewards();
  const celebrated = useRef(false);

  useEffect(() => {
    const fresh = rewards.data?.newlyUnlocked ?? [];
    if (!fresh.length || celebrated.current) return;
    celebrated.current = true;
    burstConfetti();
    for (const id of fresh) {
      const a = rewards.data!.achievements.find((x) => x.id === id);
      if (a) toast({ icon: a.icon, title: `Achievement unlocked: ${a.title}`, body: `+${a.points} points` });
    }
  }, [rewards.data]);

  if (rewards.isPending) return <LoadingBlock label="Loading rewards" />;
  if (rewards.isError) return <ErrorState error={rewards.error} onRetry={() => rewards.refetch()} />;
  return <RewardsView data={rewards.data} />;
}

function RewardsView({ data }: { data: RewardsSummaryDTO }) {
  const queryClient = useQueryClient();
  const points = useCountUp(data.points.balance);
  const level = data.level;

  const claim = useMutation({
    mutationFn: (questId: string) => api<RewardsSummaryDTO>(`/api/rewards/quests/${questId}/claim`, { method: 'POST' }),
    onSuccess: (summary, questId) => {
      queryClient.setQueryData(['rewards'], summary);
      const quest = summary.quests.find((q) => q.id === questId);
      burstConfetti();
      toast({ icon: '🎉', title: `Quest complete: ${quest?.title ?? ''}`, body: `+${quest?.points ?? 0} points` });
    },
  });

  return (
    <div className="stack-lg">
      <PageHeader title="Rewards" description="Earn Gullak points for good saving habits, free games and learning. Playing never costs anything." />

      <div className="rewards-hero stagger">
        <section className="card hero" aria-labelledby="points-title">
          <div className="hero__label" id="points-title">
            <span className="hero__live" aria-hidden="true" /> Gullak points
          </div>
          <div className="points-big gold-text num" aria-live="polite">
            {points.toLocaleString('en-IN')}
          </div>
          <p className="hero__sub">
            Worth a {formatINR(pointsToPaise(data.points.balance))} simulated reward credit · {data.points.lifetimeEarned.toLocaleString('en-IN')} earned in total
          </p>
          <div className="hero__stats">
            <span className="streak" aria-label={`${data.streak.weeks}-week saving streak`}>
              <span className="streak__flame" aria-hidden="true">
                🔥
              </span>
              {data.streak.weeks}-week streak
            </span>
            {!data.streak.savedThisWeek ? <span className="hero__stat">Save ₹100+ this week to keep it going</span> : null}
          </div>
        </section>

        <section className="card stack" aria-labelledby="level-title">
          <div className="row">
            <span className="level-medal" aria-hidden="true">
              {LEVEL_ICONS[level.index]}
            </span>
            <div>
              <div className="tiny muted">Your level</div>
              <h2 id="level-title" className="gold-text" style={{ margin: 0, fontSize: '1.5rem' }}>
                {level.name}
              </h2>
            </div>
          </div>
          <div className="progress progress--lg" role="progressbar" aria-label="Progress to next level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level.progressPercent}>
            <div className="progress__bar" style={{ width: `${level.progressPercent}%` }} />
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {level.nextName
              ? `${(level.nextMin! - data.points.lifetimeEarned).toLocaleString('en-IN')} more points to ${level.nextName}`
              : 'Top level reached — amazing saving!'}
          </p>
        </section>
      </div>

      <section aria-labelledby="quests-title">
        <div className="section-title">
          <h2 id="quests-title">Weekly quests</h2>
          <span className="tiny muted">
            {formatDateIN(data.weekStart)} – {formatDateIN(data.weekEnd)}
          </span>
        </div>
        {claim.isError ? <Notice tone="error">{errorMessage(claim.error)}</Notice> : null}
        <div className="grid-goals stagger">
          {data.quests.map((q) => (
            <div key={q.id} className={`card quest ${q.status === 'claimable' ? 'quest--claimable' : ''} ${q.status === 'claimed' ? 'quest--claimed' : ''}`}>
              <QuestRing quest={q} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{q.title}</div>
                <div className="tiny muted">{q.description}</div>
                <div className="tiny" style={{ marginTop: 4, color: 'var(--gold-2)' }}>
                  {progressText(q)} · +{q.points} pts
                </div>
              </div>
              {q.status === 'claimable' ? (
                <button type="button" className="btn btn--primary btn--small" onClick={() => claim.mutate(q.id)} disabled={claim.isPending}>
                  Claim
                </button>
              ) : q.status === 'claimed' ? (
                <span className="badge badge--completed">Claimed</span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="games-title">
        <div className="section-title">
          <h2 id="games-title">Play &amp; learn</h2>
          <span className="tiny muted">Free to play · points have no cash value outside the demo</span>
        </div>
        <div className="grid-goals stagger">
          <Link to="/rewards/coin-catch" className="card game-card">
            <span className="game-card__art" aria-hidden="true">
              🪙
            </span>
            <h3 style={{ margin: 0 }}>Coin Catch</h3>
            <p className="small muted" style={{ margin: 0 }}>
              Catch falling coins in your gullak, dodge the impulse buys. 30 seconds.
            </p>
            <span className="chip chip--gold" style={{ alignSelf: 'flex-start' }}>
              {data.games.coinCatch.rewardedPlaysLeft > 0
                ? `${data.games.coinCatch.rewardedPlaysLeft} rewarded play${data.games.coinCatch.rewardedPlaysLeft > 1 ? 's' : ''} left today · up to ${data.games.coinCatch.maxPointsPerGame} pts`
                : 'Practice mode — rewards reset tomorrow'}
            </span>
          </Link>
          <Link to="/rewards/quiz" className="card game-card">
            <span className="game-card__art" aria-hidden="true">
              🧠
            </span>
            <h3 style={{ margin: 0 }}>Money Quiz</h3>
            <p className="small muted" style={{ margin: 0 }}>
              5 quick questions on saving and staying safe from fraud. 10 pts each, +50 for a perfect score.
            </p>
            <span className="chip chip--gold" style={{ alignSelf: 'flex-start' }}>
              {data.games.quiz.playedToday ? 'Done today — new quiz tomorrow' : 'Today’s quiz is ready'}
            </span>
          </Link>
        </div>
      </section>

      <RedeemCard data={data} />

      <section aria-labelledby="ach-title">
        <div className="section-title">
          <h2 id="ach-title">Achievements</h2>
          <span className="tiny muted">
            {data.achievements.filter((a) => a.unlocked).length} of {data.achievements.length} unlocked
          </span>
        </div>
        <div className="badge-grid stagger">
          {data.achievements.map((a) => (
            <div key={a.id} className={`card ach ${a.unlocked ? 'ach--on' : ''} ${data.newlyUnlocked.includes(a.id) ? 'ach--new' : ''}`}>
              <span className="ach__icon" aria-hidden="true">
                {a.icon}
              </span>
              <span className="ach__title">{a.title}</span>
              <span className="tiny muted">{a.description}</span>
              <span className="tiny" style={{ color: a.unlocked ? 'var(--gold-2)' : 'var(--muted)' }}>
                {a.unlocked ? `Unlocked · +${a.points}` : `Locked · ${a.points} pts`}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="history-title">
        <h2 id="history-title">Points history</h2>
        {data.history.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No points yet. Create a goal, save ₹100 or play a game to get started.
          </p>
        ) : (
          <ul className="list">
            {data.history.map((h) => (
              <li key={h.id} className="list-item">
                <span className="list-item__icon list-item__icon--reward">
                  <Icon name={h.points > 0 ? 'zap' : 'gift'} />
                </span>
                <span className="list-item__body">
                  <span className="list-item__title">{h.note}</span>
                  <span className="list-item__meta">{formatDateTimeIN(h.createdAt)}</span>
                </span>
                <span className={`list-item__amount num ${h.points > 0 ? 'amount-in' : ''}`}>
                  {h.points > 0 ? '+' : '−'}
                  {Math.abs(h.points).toLocaleString('en-IN')} pts
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <DemoNotice>
        <p>
          Points reward saving habits and free play — you never pay or stake money to play. Points have no cash value outside this demo.
          Redeeming creates a <strong>simulated</strong> reward credit; no real money moves. In a live product, any reward credit would be funded
          by the partner bank under published terms.
        </p>
      </DemoNotice>
    </div>
  );
}

function RedeemCard({ data }: { data: RewardsSummaryDTO }) {
  const goals = useGoals('active');
  const refresh = useRefreshMoney();
  const navigate = useNavigate();
  const { redemption } = data;
  const capLeftPoints = Math.max(0, Math.floor((redemption.dailyCapPaise - redemption.redeemedTodayPaise) / redemption.paisePerPoint));
  const maxPoints = Math.floor(Math.min(data.points.balance, capLeftPoints) / redemption.stepPoints) * redemption.stepPoints;
  const [goalId, setGoalId] = useState('');
  const [points, setPoints] = useState(redemption.minPoints);
  const key = useRef(newIdempotencyKey());
  const canRedeem = maxPoints >= redemption.minPoints;

  const redeem = useMutation({
    mutationFn: () =>
      api<CreateTransferResponse>('/api/rewards/redeem', {
        method: 'POST',
        body: { goalId, points: Math.min(points, maxPoints) },
        idempotencyKey: key.current,
      }),
    onSuccess: async (result) => {
      key.current = newIdempotencyKey();
      burstConfetti();
      toast({ icon: '🪙', title: 'Reward credit requested', body: `${formatINR(result.transaction.amountPaise)} (simulated) is on its way to your goal` });
      await refresh();
      navigate(`/activity/${result.transaction.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (goalId && canRedeem) redeem.mutate();
  };

  return (
    <section className="card stack" aria-labelledby="redeem-title">
      <div className="row-between">
        <h2 id="redeem-title" style={{ margin: 0 }}>
          Redeem points into a goal
        </h2>
        <SimChip label="Simulated credit" />
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        10 points = ₹1 of simulated reward credit. Minimum {redemption.minPoints} points; up to {formatINR(redemption.dailyCapPaise)} a day.
      </p>
      {!canRedeem ? (
        <Notice tone="info">
          {data.points.balance < redemption.minPoints
            ? `You need ${redemption.minPoints - data.points.balance} more points to redeem.`
            : 'You’ve reached today’s redemption limit. Try again tomorrow.'}
        </Notice>
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="redeem-goal">Goal</label>
            <select id="redeem-goal" className="select" value={goalId} onChange={(e) => setGoalId(e.target.value)} required>
              <option value="">Choose a goal…</option>
              {(goals.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.icon} {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="redeem-points">
              Points: <span className="num gold-text">{points.toLocaleString('en-IN')}</span> → <span className="num">{formatINR(pointsToPaise(points))}</span>
            </label>
            <input
              id="redeem-points"
              type="range"
              min={redemption.minPoints}
              max={maxPoints}
              step={redemption.stepPoints}
              value={Math.min(points, maxPoints)}
              onChange={(e) => setPoints(Number(e.target.value))}
              style={{ accentColor: 'var(--gold-2)' }}
            />
          </div>
          {redeem.isError ? <Notice tone="error">{errorMessage(redeem.error)}</Notice> : null}
          <button type="submit" className="btn btn--primary btn--lg" disabled={!goalId || redeem.isPending}>
            {redeem.isPending ? 'Redeeming…' : `Redeem ${Math.min(points, maxPoints).toLocaleString('en-IN')} points`}
          </button>
        </form>
      )}
    </section>
  );
}
