// Payouts. Earnings sit in the node's ledger account as credits (1 credit =
// $1). An operator asks for them to be sent as USDC on Solana; the request is
// debited at once so it cannot be double-spent, then waits in a queue for a
// person to look at it, send the transfer from the treasury wallet, and
// record the transaction reference. Rejecting puts the credits back.
//
// Nothing here talks to a chain. That is deliberate: a human approves every
// transfer, and the console shows them who is asking, where to, how much,
// and what that account's balance is.

import type { Db } from '../db/index.js';
import { id, nowMs } from '../db/index.js';
import type { Ledger } from './ledger.js';
import { PAYOUT_MIN_MICRO } from '@nightshift/shared';

export type Rail = 'usdc';
export type PayoutStatus = 'pending' | 'sent' | 'rejected';

export interface PayoutRequest {
  id: string;
  accountId: string;
  amountMicro: number;
  rail: Rail;
  address: string;
  status: PayoutStatus;
  txRef?: string;
  note?: string;
  createdAt: number;
  settledAt?: number;
}

/** What the operator sees in the review queue. */
export interface PayoutReview extends PayoutRequest {
  nodeId: string;
  nodeLabel: string;
  /** The requester's balance right now (after this request's debit). */
  balanceMicro: number;
  /** Lifetime earnings and tasks, for a sanity check against the amount. */
  earnedMicro: number;
  jobsDone: number;
  /** Other requests from the same account, any status. */
  priorRequests: number;
  /** Other accounts that have asked to be paid to this same address. */
  addressSharedWith: number;
}

/** Solana addresses (USDC on Solana included) are base58, 32..44 chars. */
export function isSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

export class Payouts {
  constructor(private db: Db, private ledger: Ledger) {}

  minimumMicro(): number {
    return PAYOUT_MIN_MICRO;
  }

  /**
   * Record a request. Rules: USDC only; a valid Solana address; the account's
   * balance must be at or above the minimum, and so must the amount; one
   * pending request per account at a time. The amount is debited now.
   */
  request(accountId: string, amountMicro: number, address: string | undefined): PayoutRequest {
    if (!Number.isInteger(amountMicro) || amountMicro <= 0) throw new Error('amount must be a positive integer of micro-credits');
    if (!address || !isSolanaAddress(address)) throw new Error('a Solana wallet address is required (base58, 32–44 characters)');
    const min = this.minimumMicro();
    const balance = this.ledger.balance(accountId);
    if (balance < min) throw new Error(`balance is below the minimum payout of $${min / 1_000_000}`);
    if (amountMicro < min) throw new Error(`minimum payout is $${min / 1_000_000}`);
    if (amountMicro > balance) throw new Error('amount exceeds balance');
    const open = this.db.prepare("SELECT id FROM payouts WHERE account_id=? AND status='pending'").get(accountId);
    if (open) throw new Error('a payout request is already waiting for review');

    const req: PayoutRequest = { id: id('po'), accountId, amountMicro, rail: 'usdc', address, status: 'pending', createdAt: nowMs() };
    this.db.transaction(() => {
      this.ledger.charge(accountId, amountMicro, req.id);
      this.db
        .prepare('INSERT INTO payouts (id, account_id, amount_micro, rail, address, status, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(req.id, accountId, amountMicro, 'usdc', address, 'pending', req.createdAt);
    })();
    return req;
  }

  /** Operator sent the USDC: record the transaction reference. */
  approve(payoutId: string, txRef: string, note?: string): PayoutRequest {
    const p = this.get(payoutId);
    if (!p) throw new Error('no such payout');
    if (p.status !== 'pending') throw new Error(`payout is already ${p.status}`);
    const ref = String(txRef ?? '').trim();
    if (ref.length < 8) throw new Error('a transaction reference is required');
    const t = nowMs();
    this.db.prepare("UPDATE payouts SET status='sent', tx_ref=?, note=?, settled_at=? WHERE id=?").run(ref, note ?? null, t, payoutId);
    return this.get(payoutId)!;
  }

  /** Operator declined: credits go back to the account. */
  reject(payoutId: string, reason?: string): PayoutRequest {
    const p = this.get(payoutId);
    if (!p) throw new Error('no such payout');
    if (p.status !== 'pending') throw new Error(`payout is already ${p.status}`);
    const t = nowMs();
    this.db.transaction(() => {
      this.db.prepare("UPDATE payouts SET status='rejected', note=?, settled_at=? WHERE id=?").run(reason ?? null, t, payoutId);
      this.ledger.post(p.accountId, p.amountMicro, 'refund', payoutId);
    })();
    return this.get(payoutId)!;
  }

  get(payoutId: string): PayoutRequest | null {
    const r = this.db.prepare('SELECT * FROM payouts WHERE id=?').get(payoutId) as Record<string, unknown> | undefined;
    return r ? rowToPayout(r) : null;
  }

  list(accountId: string): PayoutRequest[] {
    const rows = this.db.prepare('SELECT * FROM payouts WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(accountId) as Array<Record<string, unknown>>;
    return rows.map(rowToPayout);
  }

  /** The review queue, pending first, with what an operator needs to decide. */
  review(limit = 200): PayoutReview[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, n.id AS node_id, n.label AS node_label, n.earned_micro, n.jobs_done
         FROM payouts p LEFT JOIN nodes n ON n.account_id = p.account_id
         ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const p = rowToPayout(r);
      const prior = this.db.prepare('SELECT COUNT(*) AS n FROM payouts WHERE account_id=? AND id<>?').get(p.accountId, p.id) as { n: number };
      const shared = this.db.prepare('SELECT COUNT(DISTINCT account_id) AS n FROM payouts WHERE address=? AND account_id<>?').get(p.address, p.accountId) as { n: number };
      return {
        ...p,
        nodeId: (r.node_id as string) ?? '',
        nodeLabel: (r.node_label as string) ?? '(no node)',
        balanceMicro: this.ledger.balance(p.accountId),
        earnedMicro: (r.earned_micro as number) ?? 0,
        jobsDone: (r.jobs_done as number) ?? 0,
        priorRequests: prior.n,
        addressSharedWith: shared.n,
      };
    });
  }
}

function rowToPayout(r: Record<string, unknown>): PayoutRequest {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    amountMicro: r.amount_micro as number,
    rail: 'usdc',
    address: r.address as string,
    status: r.status as PayoutStatus,
    txRef: (r.tx_ref as string) ?? undefined,
    note: (r.note as string) ?? undefined,
    createdAt: r.created_at as number,
    settledAt: (r.settled_at as number) ?? undefined,
  };
}
