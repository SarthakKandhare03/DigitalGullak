import { Link } from 'react-router';
import { formatDateIN } from '../../../shared/dates';
import { formatINR, progressPercent } from '../../../shared/money';
import type { GoalDTO } from '../../../shared/types';
import { Money, Progress } from './ui';

export function GoalCard({ goal }: { goal: GoalDTO }) {
  const saved = goal.balance.postedPaise;
  const pct = progressPercent(saved, goal.targetPaise);
  const pending = goal.balance.pendingInPaise + goal.balance.pendingOutPaise;
  return (
    <Link to={`/goals/${goal.id}`} className="card goal-card">
      <div className="goal-card__head">
        <span className="goal-icon" aria-hidden="true">
          {goal.icon}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="goal-card__name">{goal.name}</div>
          <div className="tiny muted">
            {goal.targetDate ? `By ${formatDateIN(goal.targetDate)}` : 'No target date'}
            {goal.isExample ? ' · Example' : ''}
          </div>
        </div>
      </div>
      <div className="goal-card__amounts">
        <span>
          <strong>
            <Money paise={saved} />
          </strong>{' '}
          <span className="muted">of {formatINR(goal.targetPaise)}</span>
        </span>
        <span className="muted num">{pct}%</span>
      </div>
      <Progress saved={saved} target={goal.targetPaise} label={`${goal.name} progress`} />
      {pending > 0 ? <span className="tiny muted">Some amounts are waiting for confirmation</span> : null}
    </Link>
  );
}
