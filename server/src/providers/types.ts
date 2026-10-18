/**
 * BankPartnerProvider — the only way the app talks to the bank partner.
 *
 * The partner's records are authoritative for where money is held, what
 * legal protection applies, balances and the final status of every transfer.
 * The app keeps its own journal of instructions and goal allocations and
 * reconciles it against the partner.
 *
 * Only a mock implementation exists in this build (see ./mock). A live
 * implementation needs a signed bank/authorised-provider agreement and the
 * partner's API, webhook and reconciliation specifications.
 */

import type { DemoScenario } from '../../../shared/types';

export type TransferDirection = 'collect' | 'payout';
export type ProviderTransferStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export interface ProviderAccount {
  customerRef: string;
  accountRef: string;
}

export interface AccountStatus {
  accountRef: string;
  status: 'active' | 'pending_verification' | 'restricted' | 'closed';
  partnerDisplayName: string;
  maskedAccountNumber: string;
  /** Where withdrawals are paid out to (the user's verified bank account). */
  payoutDestinationLabel: string;
  /** Where contributions are collected from. */
  fundingSourceLabel: string;
  simulated: boolean;
}

export interface ProviderBalance {
  accountRef: string;
  ledgerBalancePaise: number;
  availableBalancePaise: number;
  asOf: string;
  simulated: boolean;
}

export interface ProviderTransfer {
  id: string;
  /** Our transaction id, echoed back by the partner. */
  reference: string;
  accountRef: string;
  direction: TransferDirection;
  amountPaise: number;
  status: ProviderTransferStatus;
  /** Monotonic per transfer; used to discard stale or out-of-order events. */
  version: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTransferRequest {
  idempotencyKey: string;
  reference: string;
  accountRef: string;
  direction: TransferDirection;
  amountPaise: number;
  description: string;
  /** Demo-only knob understood by the mock provider. Live providers must ignore it. */
  demoScenario?: DemoScenario;
}

/** Interest terms exactly as supplied by the partner. Never invented by the app. */
export interface InterestTerms {
  annualRateText: string;
  termsUrl: string;
  effectiveFrom: string;
}

export type ProviderEventType =
  | 'transfer.pending'
  | 'transfer.completed'
  | 'transfer.failed'
  | 'transfer.reversed'
  | 'account.status_changed'
  | 'interest.credited';

export interface ProviderEvent {
  id: string;
  type: ProviderEventType;
  occurredAt: string;
  transfer: ProviderTransfer | null;
  accountRef: string | null;
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export class WebhookVerificationError extends Error {}

export interface BankPartnerProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isSimulated: boolean;

  openAccount(input: { userId: string }): Promise<ProviderAccount>;
  closeAccount(accountRef: string): Promise<void>;
  getAccountStatus(accountRef: string): Promise<AccountStatus>;
  getBalance(accountRef: string): Promise<ProviderBalance>;
  listTransfers(accountRef: string): Promise<ProviderTransfer[]>;
  getTransfer(transferId: string): Promise<ProviderTransfer | null>;
  findTransferByReference(reference: string): Promise<ProviderTransfer | null>;
  /** Must be idempotent on `idempotencyKey`. */
  createTransfer(request: CreateTransferRequest): Promise<ProviderTransfer>;
  /** null unless the partner supplies real terms. */
  getInterestTerms(accountRef: string): Promise<InterestTerms | null>;
  /** Verifies the signature and timestamp, then parses. Throws WebhookVerificationError. */
  verifyAndParseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderEvent;
}
