import { useState } from 'react';
import { ActivityList } from '../components/ActivityList';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '../components/ui';
import { useActivity, type ActivityFilters } from '../lib/queries';

const TYPES: Array<[NonNullable<ActivityFilters['type']>, string]> = [
  ['all', 'All'],
  ['contribution', 'Savings added'],
  ['withdrawal', 'Withdrawals'],
  ['schedule', 'Schedule changes'],
];

export function ActivityPage() {
  const [type, setType] = useState<NonNullable<ActivityFilters['type']>>('all');
  const [status, setStatus] = useState<ActivityFilters['status']>();
  const activity = useActivity({ type, status: type === 'schedule' ? undefined : status });
  const items = activity.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="stack">
      <PageHeader title="Activity" description="Every simulated saving, withdrawal and schedule change, with its status." />
      <div className="row-between">
        <div className="chips" role="group" aria-label="Filter by type">
          {TYPES.map(([value, label]) => (
            <button key={value} type="button" className="choice-chip" aria-pressed={type === value} onClick={() => setType(value)}>
              {label}
            </button>
          ))}
        </div>
        {type !== 'schedule' ? (
          <div className="field" style={{ minWidth: 180 }}>
            <label htmlFor="status-filter" className="sr-only">
              Filter by status
            </label>
            <select id="status-filter" className="select" value={status ?? ''} onChange={(e) => setStatus((e.target.value || undefined) as ActivityFilters['status'])}>
              <option value="">Any status</option>
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="reversed">Reversed</option>
            </select>
          </div>
        ) : null}
      </div>

      <p className="tiny muted" style={{ margin: 0 }}>
        <strong>Pending</strong>: waiting for partner confirmation · <strong>Completed</strong>: confirmed · <strong>Failed</strong>: not completed, balance
        unchanged · <strong>Simulated</strong>: demo record, no real money · <strong>Recorded</strong>: schedule change, no money involved
      </p>

      <div className="card">
        {activity.isPending ? (
          <LoadingBlock lines={3} />
        ) : activity.isError ? (
          <ErrorState error={activity.error} onRetry={() => activity.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="Nothing here yet">Try a different filter, or add some simulated savings to a goal.</EmptyState>
        ) : (
          <>
            <ActivityList items={items} />
            {activity.hasNextPage ? (
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <button type="button" className="btn btn--secondary" onClick={() => activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
                  {activity.isFetchingNextPage ? 'Loading…' : 'Show older activity'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
