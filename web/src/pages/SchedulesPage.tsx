import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { describeFrequency, formatDateIN } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import type { CreateTransferResponse, ScheduleDTO } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { ConfirmDialog, DemoNotice, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader, ScheduleStatusBadge, SimChip } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useRefreshMoney, useSchedules } from '../lib/queries';

export function SchedulesPage() {
  const schedules = useSchedules();
  const refresh = useRefreshMoney();
  const navigate = useNavigate();
  const [cancelTarget, setCancelTarget] = useState<ScheduleDTO | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'pause' | 'resume' | 'cancel' }) => api<ScheduleDTO>(`/api/schedules/${id}/${verb}`, { method: 'POST' }),
    onSuccess: async (s, { verb }) => {
      setCancelTarget(null);
      setMessage(
        verb === 'pause'
          ? `Paused ${formatINR(s.amountPaise)} for ${s.goalName}. Nothing will be simulated until you resume.`
          : verb === 'resume'
            ? `Resumed. Next simulated date: ${s.nextRunDate ? formatDateIN(s.nextRunDate) : '—'}.`
            : `Cancelled the schedule for ${s.goalName}.`,
      );
      await refresh();
    },
  });

  const simulate = useMutation({
    mutationFn: (id: string) => api<CreateTransferResponse>(`/api/schedules/${id}/simulate-run`, { method: 'POST' }),
    onSuccess: async (data) => {
      await refresh();
      navigate(`/activity/${data.transaction.id}`);
    },
  });

  const list = schedules.data ?? [];
  const open = list.filter((s) => s.status !== 'cancelled');
  const cancelled = list.filter((s) => s.status === 'cancelled');

  return (
    <div className="stack">
      <PageHeader
        title="Savings schedules"
        description="Save a fixed amount daily, weekly or monthly — simulated in this demo."
        actions={
          <Link to="/schedules/new" className="btn btn--primary">
            <Icon name="plus" /> New schedule
          </Link>
        }
      />
      <DemoNotice>
        <p>
          <strong>No automatic debit will occur in demo mode.</strong> Schedules here are simulations. Use “Simulate next run” to see what a
          scheduled contribution would look like.
        </p>
        <p>
          In a real version, each schedule needs a mandate you approve with your bank (for example UPI AutoPay), a notice at least 24 hours
          before each debit, and controls to pause or cancel at any time.
        </p>
      </DemoNotice>

      <div aria-live="polite">{message ? <Notice tone="ok">{message}</Notice> : null}</div>
      {action.isError ? <Notice tone="error">{errorMessage(action.error)}</Notice> : null}
      {simulate.isError ? <Notice tone="error">{errorMessage(simulate.error)}</Notice> : null}

      {schedules.isPending ? (
        <LoadingBlock lines={2} />
      ) : schedules.isError ? (
        <ErrorState error={schedules.error} onRetry={() => schedules.refetch()} />
      ) : open.length === 0 ? (
        <EmptyState
          title="No schedules"
          action={
            <Link to="/schedules/new" className="btn btn--primary">
              Create a simulated schedule
            </Link>
          }
        >
          A schedule sets aside the same amount on a regular day, so saving happens without thinking about it.
        </EmptyState>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {open.map((s) => (
            <li key={s.id} className="card stack" aria-labelledby={`sched-${s.id}`}>
              <div className="row-between">
                <div className="row">
                  <span className="goal-icon" aria-hidden="true">
                    {s.goalIcon}
                  </span>
                  <div>
                    <h2 id={`sched-${s.id}`} style={{ margin: 0 }}>
                      <span className="num">{formatINR(s.amountPaise)}</span> {describeFrequency(s.frequency, s.anchor)}
                    </h2>
                    <div className="small muted">
                      to <Link to={`/goals/${s.goalId}`}>{s.goalName}</Link>
                    </div>
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <ScheduleStatusBadge status={s.status} />
                  <SimChip />
                  {s.origin === 'sample' ? <span className="chip chip--sample">Sample</span> : null}
                </div>
              </div>
              <dl className="kv small">
                <dt>Next simulated date</dt>
                <dd>{s.status === 'active' && s.nextRunDate ? formatDateIN(s.nextRunDate) : 'None while paused'}</dd>
                <dt>Amount each time</dt>
                <dd className="num">{formatINR(s.amountPaise)} (limit per run)</dd>
                <dt>Simulated runs so far</dt>
                <dd>{s.runsCount}</dd>
                <dt>Started</dt>
                <dd>{formatDateIN(s.startDate)}</dd>
              </dl>
              <div className="btn-row">
                {s.status === 'active' ? (
                  <>
                    <button type="button" className="btn btn--secondary btn--small" onClick={() => simulate.mutate(s.id)} disabled={simulate.isPending}>
                      <Icon name="play" size={16} /> Simulate next run
                    </button>
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => action.mutate({ id: s.id, verb: 'pause' })} disabled={action.isPending}>
                      <Icon name="pause" size={16} /> Pause
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn--secondary btn--small" onClick={() => action.mutate({ id: s.id, verb: 'resume' })} disabled={action.isPending}>
                    <Icon name="play" size={16} /> Resume
                  </button>
                )}
                <button type="button" className="btn btn--danger-outline btn--small" onClick={() => setCancelTarget(s)}>
                  Cancel schedule
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {cancelled.length ? (
        <details className="disclosure">
          <summary>Cancelled schedules ({cancelled.length})</summary>
          <ul className="list">
            {cancelled.map((s) => (
              <li key={s.id} className="list-item">
                <span className="list-item__body">
                  <span className="list-item__title">
                    {formatINR(s.amountPaise)} {describeFrequency(s.frequency, s.anchor)} · {s.goalName}
                  </span>
                  <span className="list-item__meta">Cancelled {s.cancelledAt ? formatDateIN(s.cancelledAt.slice(0, 10)) : ''}</span>
                </span>
                <ScheduleStatusBadge status="cancelled" />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        title="Cancel this schedule?"
        confirmLabel="Cancel schedule"
        cancelLabel="Keep it"
        tone="danger"
        busy={action.isPending}
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => cancelTarget && action.mutate({ id: cancelTarget.id, verb: 'cancel' })}
      >
        {cancelTarget ? (
          <p style={{ margin: 0 }}>
            {formatINR(cancelTarget.amountPaise)} {describeFrequency(cancelTarget.frequency, cancelTarget.anchor)} to {cancelTarget.goalName} will stop. Money
            already saved stays in the goal. A cancelled schedule can’t be restarted, but you can create a new one.
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
