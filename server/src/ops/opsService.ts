import { all, one, tx, type DB } from '../db/db';
import type { LedgerService } from '../ledger/ledgerService';
import { TXN_SELECT, toTransactionDTO, type TxnRow } from '../ledger/rows';
import { notFound, unprocessable } from '../lib/errors';
import { MockBankProvider } from '../providers/mock/mockBankProvider';
import type { BankPartnerProvider } from '../providers/types';
import type { AuditLog } from './audit';
import type { ExceptionStore } from './exceptions';
import type { ReconciliationService } from './reconciliation';
import type { SecurityEvents } from '../lib/securityEvents';

/** Read models and demo tools for the operator console. Customer PII is limited to the last 4 phone digits. */
export class OpsService {
  constructor(
    private readonly db: DB,
    private readonly provider: BankPartnerProvider,
    private readonly ledger: LedgerService,
    private readonly exceptions: ExceptionStore,
    private readonly recon: ReconciliationService,
    private readonly audit: AuditLog,
    private readonly securityEvents: SecurityEvents,
  ) {}

  overview() {
    const count = (sql: string) => one<{ n: number }>(this.db, sql)!.n;
    const events = all<{ processing_status: string; n: number; deliveries: number }>(
      this.db,
      'SELECT processing_status, COUNT(*) AS n, SUM(delivery_count) AS deliveries FROM provider_events GROUP BY processing_status',
    );
    const security = this.securityEvents.summary();
    return {
      users: count(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`),
      pendingTransactions: count(`SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending'`),
      failedTransactions: count(`SELECT COUNT(*) AS n FROM transactions WHERE status = 'failed'`),
      unresolvedExceptions: this.exceptions.countUnresolved(),
      providerEvents: Object.fromEntries(events.map((e) => [e.processing_status, e.n])),
      duplicateDeliveries: events.reduce((sum, e) => sum + (e.deliveries - e.n), 0),
      rejectedWebhooks: security.webhook_rejected ?? 0,
      securityEvents24h: security,
      integrity: all<{ chain: string; last_rowid: number; verified_at: string }>(this.db, 'SELECT chain, last_rowid, verified_at FROM integrity_checkpoints').map(
        (c) => ({ chain: c.chain, verifiedThroughRow: c.last_rowid, verifiedAt: c.verified_at }),
      ),
      lastReconciliation: this.recon.lastRun(),
      provider: { id: this.provider.id, displayName: this.provider.displayName, simulated: this.provider.isSimulated },
    };
  }

  securityLog() {
    return this.securityEvents.recent(100);
  }

  users() {
    return all<{ id: string; phone_last4: string; display_name: string | null; status: string; created_at: string }>(
      this.db,
      'SELECT id, phone_last4, display_name, status, created_at FROM users ORDER BY created_at DESC LIMIT 200',
    ).map((u) => ({
      id: u.id,
      phoneLast4: u.phone_last4,
      displayName: u.display_name,
      status: u.status,
      createdAt: u.created_at,
      totals: this.ledger.userTotals(u.id),
    }));
  }

  transactions(filter: { status?: string; userId?: string }) {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      conditions.push('t.status = ?');
      params.push(filter.status);
    }
    if (filter.userId) {
      conditions.push('t.user_id = ?');
      params.push(filter.userId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return all<TxnRow>(this.db, `${TXN_SELECT} ${where} ORDER BY t.created_at DESC LIMIT 100`, ...params).map((r) => ({
      ...toTransactionDTO(r),
      userId: r.user_id,
    }));
  }

  providerEvents() {
    return all<{
      id: number;
      event_id: string;
      type: string;
      transfer_ref: string | null;
      reference: string | null;
      processing_status: string;
      processing_note: string | null;
      delivery_count: number;
      received_at: string;
      last_received_at: string;
    }>(this.db, 'SELECT * FROM provider_events ORDER BY received_at DESC, id DESC LIMIT 100').map((e) => ({
      id: e.id,
      eventId: e.event_id,
      type: e.type,
      transferRef: e.transfer_ref,
      reference: e.reference,
      processingStatus: e.processing_status,
      processingNote: e.processing_note,
      deliveryCount: e.delivery_count,
      receivedAt: e.received_at,
      lastReceivedAt: e.last_received_at,
    }));
  }

  private mock(): MockBankProvider {
    if (!(this.provider instanceof MockBankProvider)) throw unprocessable('not_mock', 'Demo tools only work with the mock provider.');
    return this.provider;
  }

  /** Demo tool: deliver an already-received partner event again (duplicate delivery). */
  async replayEvent(operatorId: string, eventId: string, reason: string) {
    const mock = this.mock();
    const status = await mock.redeliver(eventId);
    tx(this.db, () =>
      this.audit.record({ operatorId, action: 'demo.replay_partner_event', targetType: 'provider_event', targetId: eventId, reason, after: { responseStatus: status } }),
    );
    return { responseStatus: status };
  }

  /** Demo tool: confirm transfers that were created with the "partner is slow" scenario. */
  async settleSlowTransfers(operatorId: string, reason: string) {
    const settled = await this.mock().settleSlowTransfers();
    tx(this.db, () =>
      this.audit.record({ operatorId, action: 'demo.settle_slow_transfers', targetType: 'mock_partner', targetId: 'mock', reason, after: { settled } }),
    );
    return { settled };
  }

  /**
   * Demo tool: the mock partner reverses a completed transfer and the webhook
   * is lost. Only reconciliation will notice; the app balance is unchanged.
   */
  simulateMissedReversal(operatorId: string, transactionId: string, reason: string) {
    const txn = this.ledger.getAny(transactionId);
    if (txn.status !== 'completed' || !txn.providerRef) throw unprocessable('not_completed', 'Choose a completed transaction.');
    const transfer = this.mock().reverseWithoutNotice(txn.providerRef);
    tx(this.db, () =>
      this.audit.record({
        operatorId,
        action: 'demo.simulate_missed_partner_reversal',
        targetType: 'transaction',
        targetId: transactionId,
        reason,
        before: { partnerStatus: 'completed' },
        after: { partnerStatus: transfer.status, webhookDelivered: false },
      }),
    );
    return { partnerStatus: transfer.status };
  }

  mockEvents() {
    return this.mock()
      .listEvents(50)
      .map((e) => ({
        id: e.id,
        type: e.type,
        transferId: e.transfer_id,
        deliveryStatus: e.delivery_status,
        attempts: e.attempts,
        lastResponseStatus: e.last_response_status,
        createdAt: e.created_at,
      }));
  }

  userDetail(userId: string) {
    const user = one<{ id: string; phone_last4: string; display_name: string | null; status: string; created_at: string }>(
      this.db,
      'SELECT id, phone_last4, display_name, status, created_at FROM users WHERE id = ?',
      userId,
    );
    if (!user) throw notFound('User not found.');
    return {
      id: user.id,
      phoneLast4: user.phone_last4,
      displayName: user.display_name,
      status: user.status,
      totals: this.ledger.userTotals(user.id),
      transactions: this.transactions({ userId }),
    };
  }
}
