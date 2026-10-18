import { MAX_TRANSFER_PAISE, MIN_TRANSFER_PAISE, formatINR } from '../../../shared/money';
import type { BalanceDTO, DemoScenario, TransactionDTO, TransactionDetailDTO, TxnKind, TxnStatus } from '../../../shared/types';
import { all, one, run, tx, type DB } from '../db/db';
import { nowIso, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { ProviderError, type BankPartnerProvider, type ProviderTransfer } from '../providers/types';
import type { ProviderAccounts } from './providerAccounts';
import { TXN_SELECT, toBalance, toTransactionDTO, toTransactionEventDTO, type TxnEventRow, type TxnRow } from './rows';

export interface CreateTransferInput {
  userId: string;
  goalId: string;
  kind: TxnKind;
  amountPaise: number;
  idempotencyKey: string;
  origin: 'manual' | 'schedule';
  scheduleId?: string;
  memo?: string;
  demoScenario?: DemoScenario;
  maxPaise?: number;
  /** Runs inside the same DB transaction that records a *new* instruction. */
  inTx?: (transactionId: string) => void;
}

export type ApplyOutcome = 'applied' | 'noop' | 'stale' | 'mismatch' | 'conflict';

/**
 * Status changes that bring the app in line with the partner's authoritative
 * state. A partner "reversed" seen while we are still pending means the
 * transfer completed and was then reversed, so both steps are recorded.
 */
const PATHS: Record<TxnStatus, Partial<Record<TxnStatus, TxnStatus[]>>> = {
  pending: { pending: [], completed: ['completed'], failed: ['failed'], reversed: ['completed', 'reversed'] },
  completed: { completed: [], reversed: ['reversed'] },
  failed: { failed: [] },
  reversed: { reversed: [] },
};

const BALANCE_FOR_GOAL = `SELECT
  COALESCE((SELECT SUM(amount_paise) FROM ledger_entries WHERE goal_id = ?1 AND account_type = 'pocket'), 0) AS posted,
  COALESCE((SELECT SUM(amount_paise) FROM transactions WHERE goal_id = ?1 AND status = 'pending' AND kind = 'contribution'), 0) AS pending_in,
  COALESCE((SELECT SUM(amount_paise) FROM transactions WHERE goal_id = ?1 AND status = 'pending' AND kind = 'withdrawal'), 0) AS pending_out`;

const BALANCE_FOR_USER = `SELECT
  COALESCE((SELECT SUM(amount_paise) FROM ledger_entries WHERE user_id = ?1 AND account_type = 'pocket'), 0) AS posted,
  COALESCE((SELECT SUM(amount_paise) FROM transactions WHERE user_id = ?1 AND status = 'pending' AND kind = 'contribution'), 0) AS pending_in,
  COALESCE((SELECT SUM(amount_paise) FROM transactions WHERE user_id = ?1 AND status = 'pending' AND kind = 'withdrawal'), 0) AS pending_out`;

export class LedgerService {
  constructor(
    private readonly db: DB,
    private readonly provider: BankPartnerProvider,
    private readonly accounts: ProviderAccounts,
    private readonly clock: Clock,
    private readonly log: { warn: (obj: object, msg: string) => void },
  ) {}

  // -------------------------------------------------------------------------
  // Balances (always derived from the append-only ledger)
  // -------------------------------------------------------------------------

  goalBalance(goalId: string): BalanceDTO {
    return toBalance(one(this.db, BALANCE_FOR_GOAL, goalId)!);
  }

  userTotals(userId: string): BalanceDTO {
    return toBalance(one(this.db, BALANCE_FOR_USER, userId)!);
  }

  // -------------------------------------------------------------------------
  // Reading the journal (always scoped to the owner)
  // -------------------------------------------------------------------------

  private row(transactionId: string): TxnRow {
    const row = one<TxnRow>(this.db, `${TXN_SELECT} WHERE t.id = ?`, transactionId);
    if (!row) throw notFound('Transaction not found.');
    return row;
  }

  getForUser(userId: string, transactionId: string): TransactionDetailDTO {
    const row = one<TxnRow>(this.db, `${TXN_SELECT} WHERE t.id = ? AND t.user_id = ?`, transactionId, userId);
    if (!row) throw notFound('Transaction not found.');
    return { ...toTransactionDTO(row), events: this.events(row.id) };
  }

  /** Unscoped read for operator tooling only. */
  getAny(transactionId: string): TransactionDetailDTO {
    const row = this.row(transactionId);
    return { ...toTransactionDTO(row), events: this.events(row.id) };
  }

  private events(transactionId: string) {
    return all<TxnEventRow>(this.db, 'SELECT * FROM transaction_events WHERE transaction_id = ? ORDER BY id', transactionId).map(
      toTransactionEventDTO,
    );
  }

  // -------------------------------------------------------------------------
  // Creating instructions
  // -------------------------------------------------------------------------

  /**
   * Records a contribution/withdrawal instruction and submits it to the
   * partner. Idempotent per (user, idempotency key): a retry returns the
   * original transaction instead of moving money twice.
   */
  async createTransfer(input: CreateTransferInput): Promise<{ transaction: TransactionDTO; replayed: boolean }> {
    const accountRef = await this.accounts.ensure(input.userId);
    const account = await this.provider.getAccountStatus(accountRef);

    const prepared = tx(this.db, () => {
      const existing = one<TxnRow>(
        this.db,
        `${TXN_SELECT} WHERE t.user_id = ? AND t.idempotency_key = ?`,
        input.userId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.goal_id !== input.goalId || existing.kind !== input.kind || existing.amount_paise !== input.amountPaise) {
          throw conflict('idempotency_key_reused', 'This request key was already used for a different transaction.');
        }
        return { id: existing.id, replayed: true };
      }

      const goal = one<{ id: string; status: string; name: string }>(
        this.db,
        'SELECT id, status, name FROM goals WHERE id = ? AND user_id = ?',
        input.goalId,
        input.userId,
      );
      if (!goal) throw notFound('Goal not found.');
      if (goal.status !== 'active') throw conflict('goal_archived', 'This goal is archived. Restore it first.');

      const max = input.maxPaise ?? MAX_TRANSFER_PAISE;
      if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < MIN_TRANSFER_PAISE || input.amountPaise > max) {
        throw unprocessable('invalid_amount', `Amount must be between ${formatINR(MIN_TRANSFER_PAISE)} and ${formatINR(max)}.`);
      }
      if (account.status !== 'active') {
        throw conflict('partner_account_inactive', 'Your partner account is not active, so savings cannot move right now.');
      }

      if (input.kind === 'withdrawal') {
        const balance = this.goalBalance(goal.id);
        if (input.amountPaise > balance.availablePaise) {
          throw unprocessable(
            'insufficient_balance',
            `You can withdraw up to ${formatINR(balance.availablePaise)} from this goal right now.`,
            { availablePaise: balance.availablePaise },
          );
        }
      }

      const id = newId('txn');
      const now = nowIso(this.clock);
      run(
        this.db,
        `INSERT INTO transactions (id, user_id, goal_id, kind, amount_paise, status, origin, schedule_id, idempotency_key,
           provider, counterparty_label, memo, simulated, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.userId,
        goal.id,
        input.kind,
        input.amountPaise,
        input.origin,
        input.scheduleId ?? null,
        input.idempotencyKey,
        this.provider.id,
        input.kind === 'contribution' ? account.fundingSourceLabel : account.payoutDestinationLabel,
        input.memo ?? null,
        this.provider.isSimulated,
        now,
        now,
      );
      this.addEvent(id, 'created', null, 'pending', input.origin === 'schedule' ? 'system' : 'user', null);
      input.inTx?.(id);
      return { id, replayed: false };
    });

    const current = this.row(prepared.id);
    // A replayed request whose first submission never reached the partner is
    // safely resubmitted with the same idempotency key.
    if (!prepared.replayed || (current.status === 'pending' && !current.provider_ref)) {
      await this.submit(prepared.id, accountRef, input.demoScenario);
    }
    return { transaction: toTransactionDTO(this.row(prepared.id)), replayed: prepared.replayed };
  }

  /** Sends an instruction to the partner. Safe to call repeatedly. */
  async submit(transactionId: string, accountRef?: string, demoScenario?: DemoScenario): Promise<void> {
    const txn = this.row(transactionId);
    if (txn.status !== 'pending') return;
    const ref = accountRef ?? (await this.accounts.ensure(txn.user_id));
    try {
      const transfer = await this.provider.createTransfer({
        idempotencyKey: txn.id,
        reference: txn.id,
        accountRef: ref,
        direction: txn.kind === 'contribution' ? 'collect' : 'payout',
        amountPaise: txn.amount_paise,
        description: `Digital Gullak ${txn.kind} — ${txn.goal_name}`,
        demoScenario,
      });
      tx(this.db, () => {
        const latest = this.row(transactionId);
        if (!latest.provider_ref) {
          run(this.db, 'UPDATE transactions SET provider_ref = ?, updated_at = ? WHERE id = ?', transfer.id, nowIso(this.clock), txn.id);
          this.addEvent(txn.id, 'submitted', null, null, `provider:${this.provider.id}`, `Partner reference ${transfer.id}`);
        }
        this.applyProviderState(txn.id, transfer, `provider:${this.provider.id}`);
      });
    } catch (error) {
      const definitive = error instanceof ProviderError && !error.retryable;
      tx(this.db, () => {
        this.addEvent(txn.id, 'submission_error', null, null, 'system', definitive ? (error as ProviderError).code : 'Partner unreachable; will retry');
        if (definitive) {
          this.transition(this.row(txn.id), 'failed', 'system', 'The partner rejected this instruction.', 'Rejected by the partner.');
        }
      });
      this.log.warn({ transactionId: txn.id, code: (error as ProviderError).code }, 'transfer submission failed');
    }
  }

  // -------------------------------------------------------------------------
  // Applying the partner's authoritative state
  // -------------------------------------------------------------------------

  /**
   * Moves a transaction to the partner's reported state. Must run inside a
   * DB transaction. Stale (lower/equal version) and conflicting updates are
   * reported, never applied.
   */
  applyProviderState(transactionId: string, transfer: ProviderTransfer, actor: string, note?: string): ApplyOutcome {
    const txn = this.row(transactionId);
    const expectedDirection = txn.kind === 'contribution' ? 'collect' : 'payout';
    if (transfer.amountPaise !== txn.amount_paise || transfer.direction !== expectedDirection || transfer.reference !== txn.id) {
      return 'mismatch';
    }
    if (txn.provider_ref && txn.provider_ref !== transfer.id) return 'mismatch';
    if (transfer.version <= txn.provider_version) return 'stale';

    const path = PATHS[txn.status][transfer.status];
    if (!path) return 'conflict';

    for (const step of path) {
      this.transition(this.row(transactionId), step, actor, note ?? null, transfer.failureReason);
    }
    run(
      this.db,
      'UPDATE transactions SET provider_version = ?, provider_ref = COALESCE(provider_ref, ?), updated_at = ? WHERE id = ?',
      transfer.version,
      transfer.id,
      nowIso(this.clock),
      transactionId,
    );
    return path.length ? 'applied' : 'noop';
  }

  private transition(txn: TxnRow, to: TxnStatus, actor: string, note: string | null, failureReason?: string | null): void {
    const now = nowIso(this.clock);
    const settles = to === 'completed' || to === 'failed';
    run(
      this.db,
      `UPDATE transactions SET status = ?, updated_at = ?, settled_at = CASE WHEN ? THEN ? ELSE settled_at END,
         failure_reason = COALESCE(?, failure_reason) WHERE id = ?`,
      to,
      now,
      settles,
      now,
      to === 'completed' ? null : (failureReason ?? null),
      txn.id,
    );
    this.addEvent(txn.id, 'status_changed', txn.status, to, actor, note);
    if (to === 'completed') this.post(txn, 'posting', now);
    if (to === 'reversed') this.post(txn, 'reversal', now);
  }

  /** Writes a balanced pair of ledger entries (pocket vs. external). */
  private post(txn: TxnRow, entryType: 'posting' | 'reversal', at: string): void {
    const sign = txn.kind === 'contribution' ? 1 : -1;
    const pocketAmount = (entryType === 'posting' ? sign : -sign) * txn.amount_paise;
    const insert = `INSERT INTO ledger_entries (transaction_id, user_id, account_type, goal_id, amount_paise, entry_type, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
    run(this.db, insert, txn.id, txn.user_id, 'pocket', txn.goal_id, pocketAmount, entryType, at);
    run(this.db, insert, txn.id, txn.user_id, 'external', null, -pocketAmount, entryType, at);
  }

  addEvent(
    transactionId: string,
    type: TxnEventRow['type'],
    from: TxnStatus | null,
    to: TxnStatus | null,
    actor: string,
    note: string | null,
  ): void {
    run(
      this.db,
      `INSERT INTO transaction_events (transaction_id, type, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      transactionId,
      type,
      from,
      to,
      actor,
      note,
      nowIso(this.clock),
    );
  }

  /** Records a sample (already-settled) transaction for demo data. Runs inside a DB transaction. */
  recordSampleTransaction(input: {
    userId: string;
    goalId: string;
    kind: TxnKind;
    amountPaise: number;
    at: string;
    providerRef: string;
    counterpartyLabel: string;
    transactionId: string;
  }): void {
    run(
      this.db,
      `INSERT INTO transactions (id, user_id, goal_id, kind, amount_paise, status, origin, idempotency_key, provider, provider_ref,
         provider_version, counterparty_label, memo, simulated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 'sample', ?, ?, ?, 1, ?, 'Sample data', 1, ?, ?)`,
      input.transactionId,
      input.userId,
      input.goalId,
      input.kind,
      input.amountPaise,
      `sample:${input.transactionId}`,
      this.provider.id,
      input.providerRef,
      input.counterpartyLabel,
      input.at,
      input.at,
    );
    run(
      this.db,
      `INSERT INTO transaction_events (transaction_id, type, from_status, to_status, actor, note, created_at) VALUES (?, 'created', NULL, 'pending', 'system', 'Sample data', ?)`,
      input.transactionId,
      input.at,
    );
    const txn = this.row(input.transactionId);
    run(
      this.db,
      `UPDATE transactions SET status = 'completed', provider_version = 2, settled_at = ?, updated_at = ? WHERE id = ?`,
      input.at,
      input.at,
      txn.id,
    );
    run(
      this.db,
      `INSERT INTO transaction_events (transaction_id, type, from_status, to_status, actor, note, created_at) VALUES (?, 'status_changed', 'pending', 'completed', ?, 'Sample data', ?)`,
      txn.id,
      `provider:${this.provider.id}`,
      input.at,
    );
    this.post(txn, 'posting', input.at);
  }
}
