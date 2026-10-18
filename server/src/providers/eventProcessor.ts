import { one, run, tx, type DB } from '../db/db';
import type { LedgerService } from '../ledger/ledgerService';
import { nowIso, type Clock } from '../lib/clock';
import type { ExceptionStore } from '../ops/exceptions';
import type { BankPartnerProvider, ProviderEvent } from './types';

export type EventOutcome =
  | 'processed'
  | 'duplicate'
  | 'ignored_stale'
  | 'unmatched'
  | 'mismatch'
  | 'conflict'
  | 'unsupported';

/**
 * Applies verified partner events. Every event is stored once (dedupe on
 * event id), then applied through the ledger's version-checked state machine,
 * so duplicates and out-of-order deliveries cannot double-post or regress a
 * transaction. Anything that cannot be applied becomes an operator exception.
 */
export class ProviderEventProcessor {
  constructor(
    private readonly db: DB,
    private readonly provider: BankPartnerProvider,
    private readonly ledger: LedgerService,
    private readonly exceptions: ExceptionStore,
    private readonly clock: Clock,
  ) {}

  process(event: ProviderEvent, verifiedPayload: string): EventOutcome {
    return tx(this.db, () => {
      const now = nowIso(this.clock);
      const existing = one<{ id: number }>(
        this.db,
        'SELECT id FROM provider_events WHERE provider = ? AND event_id = ?',
        this.provider.id,
        event.id,
      );
      if (existing) {
        run(this.db, 'UPDATE provider_events SET delivery_count = delivery_count + 1, last_received_at = ? WHERE id = ?', now, existing.id);
        return 'duplicate';
      }

      const transfer = event.transfer;
      run(
        this.db,
        `INSERT INTO provider_events (provider, event_id, type, transfer_ref, reference, payload, processing_status, occurred_at, received_at, last_received_at)
         VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)`,
        this.provider.id,
        event.id,
        event.type,
        transfer?.id ?? null,
        transfer?.reference ?? null,
        verifiedPayload,
        event.occurredAt,
        now,
        now,
      );

      let outcome: EventOutcome;
      let note: string | null = null;

      if (!transfer || !event.type.startsWith('transfer.')) {
        outcome = 'unsupported';
        note = `Event type ${event.type} is not handled in this build.`;
      } else {
        const txn = one<{ id: string; user_id: string }>(
          this.db,
          'SELECT id, user_id FROM transactions WHERE provider = ? AND (provider_ref = ? OR id = ?)',
          this.provider.id,
          transfer.id,
          transfer.reference,
        );
        if (!txn) {
          outcome = 'unmatched';
          note = 'No matching transaction in the app journal.';
          this.exceptions.raise({
            kind: 'unmatched_event',
            dedupeKey: `unmatched_event:${event.id}`,
            details: { eventId: event.id, eventType: event.type, transferId: transfer.id, reference: transfer.reference, amountPaise: transfer.amountPaise },
          });
        } else {
          const result = this.ledger.applyProviderState(txn.id, transfer, `provider:${this.provider.id}`, `Partner event ${event.type}`);
          if (result === 'applied' || result === 'noop') outcome = 'processed';
          else if (result === 'stale') {
            outcome = 'ignored_stale';
            note = `Event version ${transfer.version} is not newer than the recorded version.`;
          } else {
            outcome = result;
            note = result === 'mismatch' ? 'Amount, direction or reference did not match the journal.' : 'Partner state conflicts with the journal.';
            this.exceptions.raise({
              kind: result === 'mismatch' ? 'event_mismatch' : 'event_conflict',
              dedupeKey: `${result}:${event.id}`,
              userId: txn.user_id,
              transactionId: txn.id,
              details: { eventId: event.id, eventType: event.type, partnerStatus: transfer.status, partnerAmountPaise: transfer.amountPaise },
            });
          }
        }
      }

      run(
        this.db,
        'UPDATE provider_events SET processing_status = ?, processing_note = ?, processed_at = ? WHERE provider = ? AND event_id = ?',
        outcome,
        note,
        now,
        this.provider.id,
        event.id,
      );
      return outcome;
    });
  }
}
