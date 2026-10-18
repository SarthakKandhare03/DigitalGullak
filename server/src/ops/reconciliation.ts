import { all, tx, run, type DB } from '../db/db';
import type { LedgerService } from '../ledger/ledgerService';
import { TXN_SELECT, type TxnRow } from '../ledger/rows';
import { nowIso, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import { conflict, notFound, unprocessable } from '../lib/errors';
import type { BankPartnerProvider, ProviderTransfer } from '../providers/types';
import type { AuditLog } from './audit';
import { RECONCILIATION_KINDS, toExceptionDTO, type ExceptionDTO, type ExceptionStore, type RaiseInput } from './exceptions';

export interface ReconciliationSummary {
  id: string;
  accountsChecked: number;
  transfersChecked: number;
  exceptionsOpened: number;
  exceptionsClosed: number;
  findings: number;
  finishedAt: string;
}

export type ResolutionAction = 'apply_partner_status' | 'retry_submission' | 'escalate' | 'mark_resolved';

export interface ReconciliationOptions {
  /** Ignore app/partner differences younger than this: the webhook may still be in flight. */
  graceMs: number;
  /** Flag transfers pending at both ends for longer than this. */
  stuckMs: number;
}

/**
 * Compares the app journal against the partner's records, which are
 * authoritative. Differences become exceptions for an operator; nothing is
 * changed automatically.
 */
export class ReconciliationService {
  constructor(
    private readonly db: DB,
    private readonly provider: BankPartnerProvider,
    private readonly ledger: LedgerService,
    private readonly exceptions: ExceptionStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly options: ReconciliationOptions = { graceMs: 30_000, stuckMs: 10 * 60_000 },
  ) {}

  async run(triggeredBy: string): Promise<ReconciliationSummary> {
    const startedAt = nowIso(this.clock);
    const nowMs = this.clock.now().getTime();
    const accounts = all<{ user_id: string; account_ref: string }>(
      this.db,
      'SELECT user_id, account_ref FROM provider_accounts WHERE provider = ?',
      this.provider.id,
    );

    const findings: RaiseInput[] = [];
    let transfersChecked = 0;

    for (const account of accounts) {
      const [transfers, balance] = await Promise.all([
        this.provider.listTransfers(account.account_ref),
        this.provider.getBalance(account.account_ref),
      ]);
      transfersChecked += transfers.length;
      const txns = all<TxnRow>(this.db, `${TXN_SELECT} WHERE t.user_id = ?`, account.user_id);
      const byId = new Map(transfers.map((t) => [t.id, t]));
      const byReference = new Map(transfers.map((t) => [t.reference, t]));
      const matched = new Set<string>();

      for (const txn of txns) {
        const partner = (txn.provider_ref ? byId.get(txn.provider_ref) : undefined) ?? byReference.get(txn.id);
        const ageMs = nowMs - Date.parse(txn.updated_at);
        const base = { userId: txn.user_id, transactionId: txn.id };

        if (!partner) {
          if (txn.status === 'pending' && !txn.provider_ref) {
            if (ageMs > this.options.graceMs) {
              findings.push({ ...base, kind: 'not_submitted', dedupeKey: `not_submitted:${txn.id}`, details: { amountPaise: txn.amount_paise, kind: txn.kind } });
            }
          } else if (txn.status !== 'failed') {
            findings.push({ ...base, kind: 'missing_at_partner', dedupeKey: `missing_at_partner:${txn.id}`, details: { appStatus: txn.status, providerRef: txn.provider_ref } });
          }
          continue;
        }

        matched.add(partner.id);
        const expectedDirection = txn.kind === 'contribution' ? 'collect' : 'payout';
        if (partner.amountPaise !== txn.amount_paise || partner.direction !== expectedDirection) {
          findings.push({
            ...base,
            kind: 'amount_mismatch',
            dedupeKey: `amount_mismatch:${txn.id}`,
            details: { appAmountPaise: txn.amount_paise, partnerAmountPaise: partner.amountPaise, partnerDirection: partner.direction },
          });
          continue;
        }
        if (partner.status !== txn.status) {
          if (ageMs > this.options.graceMs) {
            findings.push({
              ...base,
              kind: 'status_mismatch',
              dedupeKey: `status_mismatch:${txn.id}`,
              details: { appStatus: txn.status, partnerStatus: partner.status, partnerVersion: partner.version, providerRef: partner.id },
            });
          }
        } else if (partner.status === 'pending' && ageMs > this.options.stuckMs) {
          findings.push({ ...base, kind: 'stuck_pending', dedupeKey: `stuck_pending:${txn.id}`, details: { pendingSince: txn.created_at, providerRef: partner.id } });
        }
      }

      const appIds = new Set(txns.map((t) => t.id));
      for (const transfer of transfers) {
        if (!matched.has(transfer.id) && !appIds.has(transfer.reference)) {
          findings.push({
            kind: 'missing_in_app',
            dedupeKey: `missing_in_app:${transfer.id}`,
            userId: account.user_id,
            details: { providerRef: transfer.id, reference: transfer.reference, partnerStatus: transfer.status, amountPaise: transfer.amountPaise },
          });
        }
      }

      const appPosted = this.ledger.userTotals(account.user_id).postedPaise;
      if (appPosted !== balance.ledgerBalancePaise) {
        findings.push({
          kind: 'balance_mismatch',
          dedupeKey: `balance_mismatch:${account.user_id}`,
          userId: account.user_id,
          details: { appPostedPaise: appPosted, partnerLedgerPaise: balance.ledgerBalancePaise, differencePaise: appPosted - balance.ledgerBalancePaise },
        });
      }
    }

    return tx(this.db, () => {
      const detectedKeys = new Set(findings.map((f) => f.dedupeKey));
      let closed = 0;
      for (const open of this.exceptions.unresolvedByKinds(RECONCILIATION_KINDS)) {
        if (!detectedKeys.has(open.dedupe_key)) {
          this.exceptions.setStatus(open.id, 'resolved', 'system', 'No longer detected by reconciliation.');
          closed++;
        }
      }
      let opened = 0;
      for (const finding of findings) if (this.exceptions.raise(finding).created) opened++;

      const id = newId('rec');
      const finishedAt = nowIso(this.clock);
      run(
        this.db,
        `INSERT INTO reconciliation_runs (id, triggered_by, started_at, finished_at, accounts_checked, transfers_checked, exceptions_opened, exceptions_closed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        triggeredBy,
        startedAt,
        finishedAt,
        accounts.length,
        transfersChecked,
        opened,
        closed,
      );
      return { id, accountsChecked: accounts.length, transfersChecked, exceptionsOpened: opened, exceptionsClosed: closed, findings: findings.length, finishedAt };
    });
  }

  lastRun(): (ReconciliationSummary & { triggeredBy: string }) | null {
    const row = all<{
      id: string;
      triggered_by: string;
      finished_at: string;
      accounts_checked: number;
      transfers_checked: number;
      exceptions_opened: number;
      exceptions_closed: number;
    }>(this.db, 'SELECT * FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 1')[0];
    if (!row) return null;
    return {
      id: row.id,
      triggeredBy: row.triggered_by,
      accountsChecked: row.accounts_checked,
      transfersChecked: row.transfers_checked,
      exceptionsOpened: row.exceptions_opened,
      exceptionsClosed: row.exceptions_closed,
      findings: row.exceptions_opened,
      finishedAt: row.finished_at,
    };
  }

  private async partnerTransferFor(transactionId: string): Promise<ProviderTransfer | null> {
    const txn = this.ledger.getAny(transactionId);
    if (txn.providerRef) return this.provider.getTransfer(txn.providerRef);
    return this.provider.findTransferByReference(txn.id);
  }

  /** Operator resolution. Every action is written to the audit log with the reason given. */
  async resolve(operatorId: string, exceptionId: string, action: ResolutionAction, reason: string): Promise<ExceptionDTO> {
    const exception = this.exceptions.get(exceptionId);
    if (!exception) throw notFound('Exception not found.');
    if (exception.status === 'resolved') throw conflict('already_resolved', 'This exception is already resolved.');
    const actor = `operator:${operatorId}`;

    if (action === 'apply_partner_status') {
      if (!exception.transaction_id) throw unprocessable('no_transaction', 'This exception is not linked to a transaction.');
      const transfer = await this.partnerTransferFor(exception.transaction_id);
      if (!transfer) throw unprocessable('no_partner_record', 'The partner has no record of this transfer, so there is no status to apply.');
      tx(this.db, () => {
        const before = this.ledger.getAny(exception.transaction_id!);
        const outcome = this.ledger.applyProviderState(before.id, transfer, actor, `Applied partner status during reconciliation: ${reason}`);
        if (outcome !== 'applied' && outcome !== 'noop') {
          throw unprocessable('cannot_apply', `The partner status could not be applied (${outcome}). Escalate to the partner instead.`);
        }
        const after = this.ledger.getAny(before.id);
        this.exceptions.setStatus(exception.id, 'resolved', actor, reason);
        this.audit.record({
          operatorId,
          action: 'reconciliation.apply_partner_status',
          targetType: 'transaction',
          targetId: before.id,
          reason,
          before: { status: before.status },
          after: { status: after.status, partnerStatus: transfer.status, exceptionId: exception.id },
        });
      });
    } else if (action === 'retry_submission') {
      if (!exception.transaction_id) throw unprocessable('no_transaction', 'This exception is not linked to a transaction.');
      const before = this.ledger.getAny(exception.transaction_id);
      if (before.status !== 'pending' || before.providerRef) {
        throw unprocessable('not_retryable', 'Only pending transactions that never reached the partner can be resubmitted.');
      }
      await this.ledger.submit(before.id);
      tx(this.db, () => {
        const after = this.ledger.getAny(before.id);
        if (after.providerRef) this.exceptions.setStatus(exception.id, 'resolved', actor, reason);
        this.audit.record({
          operatorId,
          action: 'reconciliation.retry_submission',
          targetType: 'transaction',
          targetId: before.id,
          reason,
          before: { status: before.status, providerRef: null },
          after: { status: after.status, providerRef: after.providerRef },
        });
      });
    } else {
      tx(this.db, () => {
        this.exceptions.setStatus(exception.id, action === 'escalate' ? 'escalated' : 'resolved', actor, reason);
        this.audit.record({
          operatorId,
          action: `reconciliation.${action}`,
          targetType: 'exception',
          targetId: exception.id,
          reason,
          before: { status: exception.status },
          after: { status: action === 'escalate' ? 'escalated' : 'resolved' },
        });
      });
    }
    return toExceptionDTO(this.exceptions.get(exception.id)!);
  }
}
