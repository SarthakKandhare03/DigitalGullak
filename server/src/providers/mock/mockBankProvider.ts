/**
 * MOCK PARTNER BANK — SIMULATION ONLY. No real money, accounts or payments.
 *
 * Behaves like a partner API so the rest of the app is built against
 * realistic constraints: transfers start pending and settle asynchronously,
 * results arrive as signed webhooks (with retries), requests are idempotent,
 * and the partner keeps its own ledger that the app must reconcile against.
 */

import { z } from 'zod';
import { all, one, run, tx, type DB } from '../../db/db';
import { type Clock } from '../../lib/clock';
import { hmacHex, newId, randomDigits, safeEqual } from '../../lib/crypto';
import type { DemoScenario } from '../../../../shared/types';
import {
  ProviderError,
  WebhookVerificationError,
  type AccountStatus,
  type BankPartnerProvider,
  type CreateTransferRequest,
  type InterestTerms,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderEvent,
  type ProviderTransfer,
  type ProviderTransferStatus,
} from '../types';
import type { Scheduler } from './scheduler';

export const MOCK_SIGNATURE_HEADER = 'x-mockbank-signature';
const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_DELIVERY_ATTEMPTS = 5;

export type WebhookTransport = (rawBody: string, headers: Record<string, string>) => Promise<number>;

interface AccountRow {
  account_ref: string;
  customer_ref: string;
  external_user_id: string;
  masked_number: string;
  linked_bank_last4: string;
  status: 'active' | 'closed';
  created_at: string;
}

interface TransferRow {
  id: string;
  idempotency_key: string;
  reference: string;
  account_ref: string;
  direction: 'collect' | 'payout';
  amount_paise: number;
  status: ProviderTransferStatus;
  version: number;
  scenario: DemoScenario;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface MockEventRow {
  id: string;
  type: string;
  transfer_id: string | null;
  payload: string;
  delivery_status: 'pending' | 'delivered' | 'failed' | 'suppressed';
  attempts: number;
  last_attempt_at: string | null;
  last_response_status: number | null;
  created_at: string;
}

const transferPayload = z.object({
  id: z.string(),
  reference: z.string(),
  account_ref: z.string(),
  direction: z.enum(['collect', 'payout']),
  amount_paise: z.number().int().positive(),
  status: z.enum(['pending', 'completed', 'failed', 'reversed']),
  version: z.number().int().positive(),
  failure_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const eventPayload = z.object({
  id: z.string(),
  type: z.enum(['transfer.pending', 'transfer.completed', 'transfer.failed', 'transfer.reversed', 'account.status_changed', 'interest.credited']),
  created_at: z.string(),
  data: z.object({
    transfer: transferPayload.optional(),
    account_ref: z.string().optional(),
  }),
});

function toTransfer(row: TransferRow): ProviderTransfer {
  return {
    id: row.id,
    reference: row.reference,
    accountRef: row.account_ref,
    direction: row.direction,
    amountPaise: row.amount_paise,
    status: row.status,
    version: row.version,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPayloadTransfer(row: TransferRow) {
  return {
    id: row.id,
    reference: row.reference,
    account_ref: row.account_ref,
    direction: row.direction,
    amount_paise: row.amount_paise,
    status: row.status,
    version: row.version,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface MockBankOptions {
  webhookSecret: string;
  settleMs: number;
  clock: Clock;
  scheduler: Scheduler;
  log?: { warn: (obj: object, msg: string) => void };
}

export class MockBankProvider implements BankPartnerProvider {
  readonly id = 'mock';
  readonly displayName = 'Demo Partner Bank (simulated)';
  readonly isSimulated = true;
  private transport: WebhookTransport | null = null;

  constructor(
    private readonly db: DB,
    private readonly options: MockBankOptions,
  ) {}

  /** Where the mock "partner" sends webhooks (our own webhook endpoint). */
  setTransport(transport: WebhookTransport): void {
    this.transport = transport;
  }

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  private account(accountRef: string): AccountRow {
    const row = one<AccountRow>(this.db, 'SELECT * FROM mockbank_accounts WHERE account_ref = ?', accountRef);
    if (!row) throw new ProviderError('account_not_found', 'Partner account not found');
    return row;
  }

  // -------------------------------------------------------------------------
  // BankPartnerProvider
  // -------------------------------------------------------------------------

  async openAccount({ userId }: { userId: string }): Promise<ProviderAccount> {
    const existing = one<AccountRow>(this.db, 'SELECT * FROM mockbank_accounts WHERE external_user_id = ?', userId);
    if (existing) return { accountRef: existing.account_ref, customerRef: existing.customer_ref };
    const accountRef = newId('mba');
    const customerRef = newId('mbc');
    run(
      this.db,
      `INSERT INTO mockbank_accounts (account_ref, customer_ref, external_user_id, masked_number, linked_bank_last4, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      accountRef,
      customerRef,
      userId,
      `XXXX XXXX ${randomDigits(4)}`,
      randomDigits(4),
      this.now(),
    );
    return { accountRef, customerRef };
  }

  async closeAccount(accountRef: string): Promise<void> {
    run(this.db, `UPDATE mockbank_accounts SET status = 'closed' WHERE account_ref = ?`, accountRef);
  }

  async getAccountStatus(accountRef: string): Promise<AccountStatus> {
    const row = this.account(accountRef);
    return {
      accountRef,
      status: row.status,
      partnerDisplayName: this.displayName,
      maskedAccountNumber: row.masked_number,
      payoutDestinationLabel: `Your bank account ••${row.linked_bank_last4} (simulated)`,
      fundingSourceLabel: `Your bank account ••${row.linked_bank_last4} (simulated)`,
      simulated: true,
    };
  }

  private balances(accountRef: string): { ledger: number; available: number } {
    const row = one<{ ledger: number; pending_out: number }>(
      this.db,
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' AND direction = 'collect' THEN amount_paise
                           WHEN status = 'completed' AND direction = 'payout' THEN -amount_paise ELSE 0 END), 0) AS ledger,
         COALESCE(SUM(CASE WHEN status = 'pending' AND direction = 'payout' THEN amount_paise ELSE 0 END), 0) AS pending_out
       FROM mockbank_transfers WHERE account_ref = ?`,
      accountRef,
    )!;
    return { ledger: row.ledger, available: row.ledger - row.pending_out };
  }

  async getBalance(accountRef: string): Promise<ProviderBalance> {
    this.account(accountRef);
    const { ledger, available } = this.balances(accountRef);
    return { accountRef, ledgerBalancePaise: ledger, availableBalancePaise: available, asOf: this.now(), simulated: true };
  }

  async listTransfers(accountRef: string): Promise<ProviderTransfer[]> {
    return all<TransferRow>(this.db, 'SELECT * FROM mockbank_transfers WHERE account_ref = ? ORDER BY created_at', accountRef).map(toTransfer);
  }

  async getTransfer(transferId: string): Promise<ProviderTransfer | null> {
    const row = one<TransferRow>(this.db, 'SELECT * FROM mockbank_transfers WHERE id = ?', transferId);
    return row ? toTransfer(row) : null;
  }

  async findTransferByReference(reference: string): Promise<ProviderTransfer | null> {
    const row = one<TransferRow>(this.db, 'SELECT * FROM mockbank_transfers WHERE reference = ? ORDER BY created_at DESC LIMIT 1', reference);
    return row ? toTransfer(row) : null;
  }

  async createTransfer(request: CreateTransferRequest): Promise<ProviderTransfer> {
    const existing = one<TransferRow>(this.db, 'SELECT * FROM mockbank_transfers WHERE idempotency_key = ?', request.idempotencyKey);
    if (existing) {
      if (
        existing.amount_paise !== request.amountPaise ||
        existing.direction !== request.direction ||
        existing.account_ref !== request.accountRef
      ) {
        throw new ProviderError('idempotency_conflict', 'Idempotency key reused with different parameters');
      }
      return toTransfer(existing);
    }

    const account = this.account(request.accountRef);
    if (account.status !== 'active') throw new ProviderError('account_inactive', 'Partner account is not active');

    const scenario: DemoScenario = request.demoScenario ?? 'confirm';
    const now = this.now();
    const id = newId('mbt');
    let status: ProviderTransferStatus = 'pending';
    let failureReason: string | null = null;
    if (request.direction === 'payout' && this.balances(request.accountRef).available < request.amountPaise) {
      status = 'failed';
      failureReason = 'Insufficient balance at the partner (simulated).';
    }

    const row = tx(this.db, () => {
      run(
        this.db,
        `INSERT INTO mockbank_transfers (id, idempotency_key, reference, account_ref, direction, amount_paise, status, version, scenario, failure_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        id,
        request.idempotencyKey,
        request.reference,
        request.accountRef,
        request.direction,
        request.amountPaise,
        status,
        scenario,
        failureReason,
        now,
        now,
      );
      const created = one<TransferRow>(this.db, 'SELECT * FROM mockbank_transfers WHERE id = ?', id)!;
      if (status === 'failed') this.recordEvent(created, 'transfer.failed', 'pending');
      return created;
    });

    if (status === 'failed') this.options.scheduler.schedule(() => this.flushPendingEvents(), 0);
    else if (scenario !== 'slow') this.options.scheduler.schedule(() => this.settle(id), this.options.settleMs);
    return toTransfer(row);
  }

  async getInterestTerms(_accountRef: string): Promise<InterestTerms | null> {
    // The demo never invents an interest rate. A live partner may return real terms here.
    return null;
  }

  verifyAndParseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const header = headers[MOCK_SIGNATURE_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) throw new WebhookVerificationError('Missing signature header');
    const parts = Object.fromEntries(
      value.split(',').map((kv) => {
        const [k, ...rest] = kv.trim().split('=');
        return [k, rest.join('=')];
      }),
    );
    const timestamp = Number(parts.t);
    if (!Number.isInteger(timestamp) || !parts.v1) throw new WebhookVerificationError('Malformed signature header');
    const nowSeconds = Math.floor(this.options.clock.now().getTime() / 1000);
    if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new WebhookVerificationError('Signature timestamp outside tolerance');
    }
    const expected = hmacHex(this.options.webhookSecret, `${timestamp}.${rawBody}`);
    if (!safeEqual(expected, parts.v1)) throw new WebhookVerificationError('Signature mismatch');

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError('Body is not JSON');
    }
    const parsed = eventPayload.safeParse(json);
    if (!parsed.success) throw new WebhookVerificationError('Unexpected event shape');
    const t = parsed.data.data.transfer;
    return {
      id: parsed.data.id,
      type: parsed.data.type,
      occurredAt: parsed.data.created_at,
      accountRef: parsed.data.data.account_ref ?? t?.account_ref ?? null,
      transfer: t
        ? {
            id: t.id,
            reference: t.reference,
            accountRef: t.account_ref,
            direction: t.direction,
            amountPaise: t.amount_paise,
            status: t.status,
            version: t.version,
            failureReason: t.failure_reason,
            createdAt: t.created_at,
            updatedAt: t.updated_at,
          }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // Mock internals: settlement and webhook delivery
  // -------------------------------------------------------------------------

  private recordEvent(transfer: TransferRow, type: string, deliveryStatus: 'pending' | 'suppressed'): string {
    const id = newId('mbe');
    const createdAt = this.now();
    const payload = JSON.stringify({ id, type, created_at: createdAt, data: { transfer: toPayloadTransfer(transfer) } });
    run(
      this.db,
      `INSERT INTO mockbank_events (id, type, transfer_id, payload, delivery_status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      type,
      transfer.id,
      payload,
      deliveryStatus,
      createdAt,
    );
    return id;
  }

  private changeStatus(transferId: string, to: ProviderTransferStatus, failureReason: string | null, notify: boolean): TransferRow {
    return tx(this.db, () => {
      run(
        this.db,
        `UPDATE mockbank_transfers SET status = ?, failure_reason = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        to,
        failureReason,
        this.now(),
        transferId,
      );
      const row = one<TransferRow>(this.db, 'SELECT * FROM mockbank_transfers WHERE id = ?', transferId)!;
      this.recordEvent(row, `transfer.${to}`, notify ? 'pending' : 'suppressed');
      return row;
    });
  }

  /** Settles a pending transfer according to its demo scenario and notifies the app. */
  async settle(transferId: string): Promise<void> {
    const row = one<TransferRow>(this.db, 'SELECT * FROM mockbank_transfers WHERE id = ?', transferId);
    if (!row || row.status !== 'pending') return;
    if (row.scenario === 'decline') {
      this.changeStatus(transferId, 'failed', 'Declined by the simulated partner (demo scenario).', true);
    } else if (row.direction === 'payout' && this.balances(row.account_ref).ledger < row.amount_paise) {
      this.changeStatus(transferId, 'failed', 'Insufficient balance at the partner (simulated).', true);
    } else {
      this.changeStatus(transferId, 'completed', null, true);
    }
    await this.flushPendingEvents();
  }

  /** Delivers every undelivered event, oldest first. */
  async flushPendingEvents(): Promise<void> {
    const pending = all<MockEventRow>(
      this.db,
      `SELECT * FROM mockbank_events WHERE delivery_status = 'pending' AND attempts = 0 ORDER BY created_at, rowid`,
    );
    for (const event of pending) await this.deliver(event.id);
  }

  private async deliver(eventId: string): Promise<void> {
    const event = one<MockEventRow>(this.db, 'SELECT * FROM mockbank_events WHERE id = ?', eventId);
    if (!event || !this.transport) return;
    const timestamp = Math.floor(this.options.clock.now().getTime() / 1000);
    const signature = hmacHex(this.options.webhookSecret, `${timestamp}.${event.payload}`);
    let status = 0;
    try {
      status = await this.transport(event.payload, {
        'content-type': 'application/json',
        [MOCK_SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
      });
    } catch (error) {
      this.options.log?.warn({ eventId, err: (error as Error).message }, 'mock partner webhook delivery failed');
    }
    const attempts = event.attempts + 1;
    const delivered = status >= 200 && status < 300;
    const nextStatus = delivered ? 'delivered' : attempts >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'pending';
    run(
      this.db,
      `UPDATE mockbank_events SET attempts = ?, last_attempt_at = ?, last_response_status = ?, delivery_status = ? WHERE id = ?`,
      attempts,
      this.now(),
      status || null,
      nextStatus,
      eventId,
    );
    if (nextStatus === 'pending') {
      this.options.scheduler.schedule(() => this.deliver(eventId), 500 * 2 ** attempts);
    }
  }

  /** On boot: finish settlements and deliveries interrupted by a restart. */
  async resumeAfterRestart(): Promise<void> {
    const pending = all<{ id: string }>(this.db, `SELECT id FROM mockbank_transfers WHERE status = 'pending' AND scenario <> 'slow'`);
    for (const t of pending) this.options.scheduler.schedule(() => this.settle(t.id), this.options.settleMs);
    const undelivered = all<{ id: string }>(this.db, `SELECT id FROM mockbank_events WHERE delivery_status = 'pending' ORDER BY created_at`);
    for (const e of undelivered) this.options.scheduler.schedule(() => this.deliver(e.id), 250);
  }

  // -------------------------------------------------------------------------
  // Demo and operator tools (mock only — not part of BankPartnerProvider)
  // -------------------------------------------------------------------------

  /** Records an already-settled transfer for sample data, without webhooks. */
  seedSettledTransfer(input: {
    accountRef: string;
    reference: string;
    direction: 'collect' | 'payout';
    amountPaise: number;
    at: string;
  }): ProviderTransfer {
    const id = newId('mbt');
    run(
      this.db,
      `INSERT INTO mockbank_transfers (id, idempotency_key, reference, account_ref, direction, amount_paise, status, version, scenario, failure_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', 2, 'confirm', NULL, ?, ?)`,
      id,
      input.reference,
      input.reference,
      input.accountRef,
      input.direction,
      input.amountPaise,
      input.at,
      input.at,
    );
    return toTransfer(one<TransferRow>(this.db, 'SELECT * FROM mockbank_transfers WHERE id = ?', id)!);
  }

  /** Confirms transfers created with the "slow" scenario. Returns how many settled. */
  async settleSlowTransfers(): Promise<number> {
    const slow = all<{ id: string }>(this.db, `SELECT id FROM mockbank_transfers WHERE status = 'pending' AND scenario = 'slow'`);
    for (const t of slow) {
      this.changeStatus(t.id, 'completed', null, true);
    }
    await this.flushPendingEvents();
    return slow.length;
  }

  /** Reverses a completed transfer but "loses" the webhook, so only reconciliation can find it. */
  reverseWithoutNotice(transferId: string): ProviderTransfer {
    const row = one<TransferRow>(this.db, 'SELECT * FROM mockbank_transfers WHERE id = ?', transferId);
    if (!row || row.status !== 'completed') throw new ProviderError('not_completed', 'Only completed transfers can be reversed');
    return toTransfer(this.changeStatus(transferId, 'reversed', 'Reversed by the simulated partner (demo drift).', false));
  }

  /** Delivers an already-delivered event again, as partners do on retries. */
  async redeliver(eventId: string): Promise<number> {
    const event = one<MockEventRow>(this.db, 'SELECT * FROM mockbank_events WHERE id = ?', eventId);
    if (!event || !this.transport) throw new ProviderError('event_not_found', 'Event not found');
    const timestamp = Math.floor(this.options.clock.now().getTime() / 1000);
    const signature = hmacHex(this.options.webhookSecret, `${timestamp}.${event.payload}`);
    return this.transport(event.payload, {
      'content-type': 'application/json',
      [MOCK_SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
    });
  }

  listEvents(limit = 50): MockEventRow[] {
    return all<MockEventRow>(this.db, 'SELECT * FROM mockbank_events ORDER BY created_at DESC, rowid DESC LIMIT ?', limit);
  }

  /** Test helper: signs an arbitrary payload exactly as the mock partner would. */
  signForTest(rawBody: string): Record<string, string> {
    const timestamp = Math.floor(this.options.clock.now().getTime() / 1000);
    return {
      'content-type': 'application/json',
      [MOCK_SIGNATURE_HEADER]: `t=${timestamp},v1=${hmacHex(this.options.webhookSecret, `${timestamp}.${rawBody}`)}`,
    };
  }
}
