import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatINR } from '../../../shared/money';
import type { GoalDTO } from '../../../shared/types';
import { GoalCard } from '../components/GoalCard';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingBlock, Notice, PageHeader } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useGoals, useRefreshMoney } from '../lib/queries';

export function GoalsPage() {
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const goals = useGoals(tab);
  const refresh = useRefreshMoney();
  const restore = useMutation({
    mutationFn: (id: string) => api<GoalDTO>(`/api/goals/${id}/restore`, { method: 'POST' }),
    onSuccess: () => refresh(),
  });

  return (
    <div>
      <PageHeader
        title="Goals"
        description="Each goal is a pocket — an allocation inside the app that shows how much is set aside for one purpose."
        actions={
          <Link to="/goals/new" className="btn btn--primary">
            <Icon name="plus" /> New goal
          </Link>
        }
      />
      <div className="tabs" role="tablist" aria-label="Goal status">
        {(['active', 'archived'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
            {value === 'active' ? 'Active' : 'Archived'}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {goals.isPending ? (
          <LoadingBlock lines={2} />
        ) : goals.isError ? (
          <ErrorState error={goals.error} onRetry={() => goals.refetch()} />
        ) : goals.data.length === 0 ? (
          tab === 'active' ? (
            <EmptyState
              title="No active goals"
              action={
                <Link to="/goals/new" className="btn btn--primary">
                  Create a goal
                </Link>
              }
            >
              Start with something you care about: an emergency fund, rent, a phone, education or travel.
            </EmptyState>
          ) : (
            <EmptyState title="No archived goals">Goals you archive will be kept here, and you can restore them any time.</EmptyState>
          )
        ) : tab === 'active' ? (
          <div className="grid-goals three">
            {goals.data.map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </div>
        ) : (
          <div className="stack">
            {restore.isError ? <Notice tone="error">{errorMessage(restore.error)}</Notice> : null}
            <ul className="list card">
              {goals.data.map((goal) => (
                <li key={goal.id} className="list-item">
                  <span className="goal-icon" aria-hidden="true">
                    {goal.icon}
                  </span>
                  <span className="list-item__body">
                    <span className="list-item__title">{goal.name}</span>
                    <span className="list-item__meta">Target {formatINR(goal.targetPaise)} · Archived</span>
                  </span>
                  <button type="button" className="btn btn--secondary btn--small" onClick={() => restore.mutate(goal.id)} disabled={restore.isPending}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
