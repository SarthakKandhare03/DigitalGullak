import type { BalanceDTO, TransactionDTO, TransactionEventDTO, TxnKind, TxnOrigin, TxnStatus } from '../../../shared/types';

export interface TxnRow {
  id: string;
  user_id: string;
  goal_id: string;
  kind: TxnKind;
  amount_paise: number;
  status: TxnStatus;
  origin: TxnOrigin;
  schedule_id: string | null;
  idempotency_key: string;
  provider: string;
  provider_ref: string | null;
  provider_version: number;
  counterparty_label: string;
  memo: string | null;
  failure_reason: string | null;
  simulated: number;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
  goal_name: string;
  goal_icon: string;
}

export interface TxnEventRow {
  id: number;
  transaction_id: string;
  type: TransactionEventDTO['type'];
  from_status: TxnStatus | null;
  to_status: TxnStatus | null;
  actor: string;
  note: string | null;
  created_at: string;
}

export const TXN_SELECT = `
  SELECT t.*, g.name AS goal_name, g.icon AS goal_icon
  FROM transactions t JOIN goals g ON g.id = t.goal_id`;

export function toTransactionDTO(row: TxnRow): TransactionDTO {
  return {
    id: row.id,
    goalId: row.goal_id,
    goalName: row.goal_name,
    goalIcon: row.goal_icon,
    kind: row.kind,
    amountPaise: row.amount_paise,
    status: row.status,
    origin: row.origin,
    scheduleId: row.schedule_id,
    memo: row.memo,
    simulated: row.simulated === 1,
    counterpartyLabel: row.counterparty_label,
    failureReason: row.failure_reason,
    providerRef: row.provider_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

export function toTransactionEventDTO(row: TxnEventRow): TransactionEventDTO {
  return {
    id: row.id,
    type: row.type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actor: row.actor,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function toBalance(row: { posted: number; pending_in: number; pending_out: number }): BalanceDTO {
  return {
    postedPaise: row.posted,
    pendingInPaise: row.pending_in,
    pendingOutPaise: row.pending_out,
    availablePaise: row.posted - row.pending_out,
  };
}
