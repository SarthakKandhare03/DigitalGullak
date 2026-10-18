/** API contract shared by the server and the web client. Money is integer paise. */

import type { Frequency, ISODate } from './dates';

export type TxnKind = 'contribution' | 'withdrawal';
export type TxnStatus = 'pending' | 'completed' | 'failed' | 'reversed';
export type TxnOrigin = 'manual' | 'schedule' | 'sample' | 'reward';
export type GoalStatus = 'active' | 'archived';
export type ScheduleStatus = 'active' | 'paused' | 'cancelled';
export type DemoScenario = 'confirm' | 'decline' | 'slow';

export const GOAL_ICONS = ['🛟', '🏠', '📱', '🎓', '✈️', '🪔', '🎁', '🏍️', '💍', '🩺', '💻', '🫙'] as const;
export type GoalIcon = (typeof GOAL_ICONS)[number];

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface PublicConfigDTO {
  demoMode: true;
  liveMoneyEnabled: false;
  provider: { id: string; displayName: string; simulated: boolean };
  limits: { minTransferPaise: number; maxTransferPaise: number; maxSchedulePaise: number; maxTargetPaise: number };
}

export interface MeDTO {
  id: string;
  displayName: string | null;
  phoneLast4: string;
  onboarded: boolean;
  createdAt: string;
}

export interface BalanceDTO {
  /** Confirmed by the (simulated) partner. */
  postedPaise: number;
  /** Contributions waiting for partner confirmation. */
  pendingInPaise: number;
  /** Withdrawals waiting for partner confirmation (held, not spendable). */
  pendingOutPaise: number;
  /** posted − pendingOut: what can be withdrawn right now. */
  availablePaise: number;
}

export interface GoalDTO {
  id: string;
  name: string;
  icon: string;
  targetPaise: number;
  targetDate: ISODate | null;
  status: GoalStatus;
  isExample: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  balance: BalanceDTO;
}

export interface TransactionDTO {
  id: string;
  goalId: string;
  goalName: string;
  goalIcon: string;
  kind: TxnKind;
  amountPaise: number;
  status: TxnStatus;
  origin: TxnOrigin;
  scheduleId: string | null;
  memo: string | null;
  simulated: boolean;
  counterpartyLabel: string;
  failureReason: string | null;
  providerRef: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

export interface TransactionEventDTO {
  id: number;
  type: 'created' | 'submitted' | 'submission_error' | 'status_changed';
  fromStatus: TxnStatus | null;
  toStatus: TxnStatus | null;
  actor: string;
  note: string | null;
  createdAt: string;
}

export interface TransactionDetailDTO extends TransactionDTO {
  events: TransactionEventDTO[];
}

export interface ScheduleDTO {
  id: string;
  goalId: string;
  goalName: string;
  goalIcon: string;
  amountPaise: number;
  frequency: Frequency;
  anchor: number | null;
  startDate: ISODate;
  nextRunDate: ISODate | null;
  status: ScheduleStatus;
  origin: 'user' | 'sample';
  simulated: boolean;
  runsCount: number;
  consentAt: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export type ScheduleEventType = 'created' | 'paused' | 'resumed' | 'cancelled' | 'simulated_run';

export interface ScheduleEventDTO {
  id: number;
  scheduleId: string;
  type: ScheduleEventType;
  transactionId: string | null;
  note: string | null;
  createdAt: string;
  goalName: string;
  goalIcon: string;
  amountPaise: number;
  frequency: Frequency;
}

export type ActivityItemDTO =
  | { type: 'transaction'; at: string; transaction: TransactionDTO }
  | { type: 'schedule_event'; at: string; event: ScheduleEventDTO };

export interface ActivityPageDTO {
  items: ActivityItemDTO[];
  nextCursor: string | null;
}

export interface PartnerAccountDTO {
  status: 'active' | 'pending_verification' | 'restricted' | 'closed' | 'not_opened';
  partnerDisplayName: string;
  maskedAccountNumber: string | null;
  linkedBankAccountLabel: string | null;
  simulated: boolean;
  /** Only ever populated from partner-supplied terms. Always null in the demo. */
  interest: { annualRateText: string; source: string } | null;
}

export interface DashboardDTO {
  totals: BalanceDTO;
  goals: GoalDTO[];
  schedules: ScheduleDTO[];
  recentActivity: ActivityItemDTO[];
  partner: PartnerAccountDTO;
}

export interface CreateTransferResponse {
  transaction: TransactionDTO;
  replayed: boolean;
}
