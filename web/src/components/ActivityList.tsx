import { Link } from 'react-router';
import { formatDateIN, formatTimeIN, todayInIST } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import type { ActivityItemDTO, ScheduleEventDTO, TransactionDTO } from '../../../shared/types';
import { Icon } from './Icon';
import { SimChip, TxnStatusBadge } from './ui';

function txnTitle(t: TransactionDTO): string {
  if (t.kind === 'contribution') return t.origin === 'schedule' ? `Scheduled saving · ${t.goalName}` : `Added to ${t.goalName}`;
  return `Withdrew from ${t.goalName}`;
}

const SCHEDULE_VERBS: Record<ScheduleEventDTO['type'], string> = {
  created: 'Schedule created',
  paused: 'Schedule paused',
  resumed: 'Schedule resumed',
  cancelled: 'Schedule cancelled',
  simulated_run: 'Simulated run',
};

function TransactionRow({ t }: { t: TransactionDTO }) {
  const incoming = t.kind === 'contribution';
  const settledOut = !incoming && t.status === 'completed';
  return (
    <Link to={`/activity/${t.id}`} className="list-item">
      <span className={`list-item__icon ${incoming ? 'list-item__icon--in' : 'list-item__icon--out'}`}>
        <Icon name={incoming ? 'arrowDown' : 'arrowUp'} />
      </span>
      <span className="list-item__body">
        <span className="list-item__title">{txnTitle(t)}</span>
        <span className="list-item__meta">
          <span>{formatTimeIN(t.createdAt)}</span>
          <SimChip />
          {t.origin === 'sample' ? <span className="chip chip--sample">Sample</span> : null}
        </span>
      </span>
      <span className="list-item__end">
        <span className={`list-item__amount num ${incoming && t.status === 'completed' ? 'amount-in' : ''}`}>
          {incoming ? '+' : settledOut ? '−' : ''}
          {formatINR(t.amountPaise)}
        </span>
        <TxnStatusBadge status={t.status} />
      </span>
    </Link>
  );
}

function ScheduleEventRow({ e }: { e: ScheduleEventDTO }) {
  return (
    <div className="list-item">
      <span className="list-item__icon list-item__icon--sched">
        <Icon name="repeat" />
      </span>
      <span className="list-item__body">
        <span className="list-item__title">
          {SCHEDULE_VERBS[e.type]} · {e.goalName}
        </span>
        <span className="list-item__meta">
          <span>{formatTimeIN(e.createdAt)}</span>
          <span>
            {formatINR(e.amountPaise)} {e.frequency}
          </span>
          <SimChip />
        </span>
      </span>
      <span className="list-item__end">
        <span className="badge badge--info">Recorded</span>
      </span>
    </div>
  );
}

function dayLabel(timestamp: string): string {
  const day = todayInIST(new Date(timestamp));
  const today = todayInIST(new Date());
  const yesterday = todayInIST(new Date(Date.now() - 86_400_000));
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  return formatDateIN(day);
}

export function ActivityList({ items, grouped = true }: { items: ActivityItemDTO[]; grouped?: boolean }) {
  const groups: Array<{ label: string; items: ActivityItemDTO[] }> = [];
  for (const item of items) {
    const label = grouped ? dayLabel(item.at) : '';
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return (
    <div>
      {groups.map((group, gi) => (
        <section key={`${group.label}-${gi}`} aria-label={group.label || 'Recent activity'}>
          {grouped ? <h3 className="date-group">{group.label}</h3> : null}
          <ul className="list">
            {group.items.map((item) => (
              <li key={item.type === 'transaction' ? item.transaction.id : `e${item.event.id}`}>
                {item.type === 'transaction' ? <TransactionRow t={item.transaction} /> : <ScheduleEventRow e={item.event} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
