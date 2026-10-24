import type { Db } from '../db/index.js';
import { id, nowMs } from '../db/index.js';
import type { LedgerEntry } from '@docket/shared';
import { FREE_GRANT_MICRO } from '@docket/shared';
import { createHash, randomBytes } from 'node:crypto';

export class InsufficientCredits extends Error {
  constructor(public needed: number, public have: number) {
    super(`insufficient credits: need ${needed}, have ${have}`);
  }
}

export class Ledger {
  constructor(private db: Db) {}

  balance(accountId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(delta_micro),0) AS bal FROM ledger WHERE account_id = ?')
      .get(accountId) as { bal: number };
    return row.bal;
  }

  entries(accountId: string, limit = 50): LedgerEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM ledger WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(accountId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      accountId: r.account_id as string,
      deltaMicro: r.delta_micro as number,
      kind: r.kind as LedgerEntry['kind'],
      ref: (r.ref as string) ?? undefined,
      createdAt: r.created_at as number,
    }));
  }

  post(accountId: string, deltaMicro: number, kind: LedgerEntry['kind'], ref?: string): LedgerEntry {
    const entry: LedgerEntry = { id: id('lg'), accountId, deltaMicro, kind, ref, createdAt: nowMs() };
    this.db
      .prepare('INSERT INTO ledger (id, account_id, delta_micro, kind, ref, created_at) VALUES (?,?,?,?,?,?)')
      .run(entry.id, accountId, deltaMicro, kind, ref ?? null, entry.createdAt);
    return entry;
  }

  /** Charge inside a transaction so two concurrent jobs can't both spend the last credit. */
  charge(accountId: string, amountMicro: number, ref: string): void {
    const tx = this.db.transaction(() => {
      const have = this.balance(accountId);
      if (have < amountMicro) throw new InsufficientCredits(amountMicro, have);
      this.post(accountId, -amountMicro, 'charge', ref);
    });
    tx();
  }

  // --- accounts -----------------------------------------------------------

  /** Anonymous session account: gets the free allowance once, keyed by a cookie. */
  ensureSession(sessionId: string): string {
    const existing = this.db.prepare('SELECT id FROM accounts WHERE id = ?').get(sessionId);
    if (existing) return sessionId;
    this.db
      .prepare('INSERT INTO accounts (id, kind, label, created_at) VALUES (?,?,?,?)')
      .run(sessionId, 'session', 'anonymous session', nowMs());
    this.post(sessionId, FREE_GRANT_MICRO, 'grant', 'welcome');
    return sessionId;
  }

  createApiKey(label: string): { accountId: string; apiKey: string } {
    const accountId = id('acct');
    const apiKey = 'dk_' + randomBytes(24).toString('base64url');
    this.db
      .prepare('INSERT INTO accounts (id, kind, label, api_key_hash, created_at) VALUES (?,?,?,?,?)')
      .run(accountId, 'key', label, hashKey(apiKey), nowMs());
    return { accountId, apiKey };
  }

  accountForKey(apiKey: string): string | null {
    const row = this.db.prepare('SELECT id FROM accounts WHERE api_key_hash = ?').get(hashKey(apiKey)) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  ensureNodeAccount(nodeId: string): string {
    const accountId = `nacct_${nodeId}`;
    const existing = this.db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId);
    if (!existing) {
      this.db
        .prepare('INSERT INTO accounts (id, kind, label, created_at) VALUES (?,?,?,?)')
        .run(accountId, 'node', `node ${nodeId}`, nowMs());
    }
    return accountId;
  }
}

function hashKey(k: string): string {
  return createHash('sha256').update(k).digest('hex');
}
