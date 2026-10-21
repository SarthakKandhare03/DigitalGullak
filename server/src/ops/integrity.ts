import { all, tx, type DB } from '../db/db';
import type { HashChain, VerifyResult } from '../lib/hashChain';
import type { ExceptionKind, ExceptionStore } from './exceptions';

export interface IntegrityReport {
  ledger: VerifyResult;
  audit: VerifyResult;
  balanceCache: { ok: boolean; driftedGoals: Array<{ goalId: string; cachedPaise: number; ledgerPaise: number }> };
}

const KINDS: ExceptionKind[] = ['ledger_chain_broken', 'audit_chain_broken', 'balance_cache_drift'];

/**
 * Periodic integrity checks: both hash chains, and the cached goal balances
 * against SUM(ledger_entries). Failures open operator exceptions; checks that
 * pass again close them.
 */
export class IntegrityService {
  constructor(
    private readonly db: DB,
    private readonly ledgerChain: HashChain,
    private readonly auditChain: HashChain,
    private readonly exceptions: ExceptionStore,
  ) {}

  /** Seals rows written before hash chains existed. Safe to call on every boot. */
  sealLegacyRows(): number {
    return tx(this.db, () => this.ledgerChain.sealPending() + this.auditChain.sealPending());
  }

  private cacheDrift() {
    return all<{ goal_id: string; cached: number; actual: number }>(
      this.db,
      `SELECT g.goal_id, g.posted_paise AS cached, COALESCE(SUM(l.amount_paise), 0) AS actual
       FROM goal_balances g LEFT JOIN ledger_entries l ON l.goal_id = g.goal_id AND l.account_type = 'pocket'
       GROUP BY g.goal_id HAVING cached <> actual
       UNION ALL
       SELECT l.goal_id, 0 AS cached, SUM(l.amount_paise) AS actual
       FROM ledger_entries l WHERE l.account_type = 'pocket' AND l.goal_id NOT IN (SELECT goal_id FROM goal_balances)
       GROUP BY l.goal_id`,
    ).map((r) => ({ goalId: r.goal_id, cachedPaise: r.cached, ledgerPaise: r.actual }));
  }

  verify(mode: 'incremental' | 'full' = 'incremental'): IntegrityReport {
    return tx(this.db, () => {
      const ledger = this.ledgerChain.verify(mode);
      const audit = this.auditChain.verify(mode);
      const driftedGoals = this.cacheDrift();
      const report: IntegrityReport = { ledger, audit, balanceCache: { ok: driftedGoals.length === 0, driftedGoals } };

      const findings: Array<{ kind: ExceptionKind; ok: boolean; details: Record<string, unknown> }> = [
        { kind: 'ledger_chain_broken', ok: ledger.ok, details: { brokenAtRowid: ledger.brokenAt, reason: ledger.reason } },
        { kind: 'audit_chain_broken', ok: audit.ok, details: { brokenAtRowid: audit.brokenAt, reason: audit.reason } },
        { kind: 'balance_cache_drift', ok: report.balanceCache.ok, details: { driftedGoals } },
      ];
      for (const f of findings) {
        if (!f.ok) this.exceptions.raise({ kind: f.kind, dedupeKey: `integrity:${f.kind}`, details: f.details });
      }
      for (const open of this.exceptions.unresolvedByKinds(KINDS)) {
        if (findings.find((f) => f.kind === open.kind)?.ok) this.exceptions.setStatus(open.id, 'resolved', 'system', 'Integrity check passed again.');
      }
      return report;
    });
  }
}
