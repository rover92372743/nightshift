// Payout rails. Earnings sit in the node's ledger account as credits. A node
// operator can leave them there (spend them on inference) or ask for them to
// be sent out over a rail.
//
// Only the `credits` rail is wired to anything here. `usdc` and `sol` go
// through the PayoutAdapter interface so a real chain integration can be
// dropped in without touching the rest of the API. The default adapter
// records the request as pending and does nothing else, which is the honest
// thing to do until there's a signer and a funded treasury behind it.

import type { Db } from '../db/index.js';
import { id, nowMs } from '../db/index.js';
import type { Ledger } from './ledger.js';
import { PAYOUT_MIN_MICRO } from '@nightshift/shared';

export type Rail = 'credits' | 'usdc' | 'sol';

export interface PayoutRequest {
  id: string;
  accountId: string;
  amountMicro: number;
  rail: Rail;
  address?: string;
  status: 'pending' | 'sent' | 'failed';
  txRef?: string;
  createdAt: number;
  settledAt?: number;
}

export interface PayoutAdapter {
  rail: Exclude<Rail, 'credits'>;
  /** Return a tx reference on success. Throw to fail the payout (credits are returned). */
  send(amountMicro: number, address: string): Promise<string>;
  validateAddress(address: string): boolean;
}

/** Placeholder adapter: validates the address shape, then leaves the payout pending for an operator. */
export class ManualAdapter implements PayoutAdapter {
  constructor(public rail: Exclude<Rail, 'credits'>) {}
  validateAddress(address: string): boolean {
    // Solana addresses (and USDC on Solana) are base58, 32..44 chars.
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }
  async send(): Promise<string> {
    throw new PayoutPending();
  }
}

export class PayoutPending extends Error {
  constructor() {
    super('payout recorded, awaiting manual settlement');
  }
}

export class Payouts {
  private adapters = new Map<string, PayoutAdapter>();

  constructor(private db: Db, private ledger: Ledger) {
    this.adapters.set('usdc', new ManualAdapter('usdc'));
    this.adapters.set('sol', new ManualAdapter('sol'));
  }

  use(adapter: PayoutAdapter): void {
    this.adapters.set(adapter.rail, adapter);
  }

  minimumMicro(rail: Rail): number {
    return rail === 'credits' ? 1 : PAYOUT_MIN_MICRO; // minimum before anything leaves the platform
  }

  async request(accountId: string, amountMicro: number, rail: Rail, address?: string): Promise<PayoutRequest> {
    if (!Number.isInteger(amountMicro) || amountMicro <= 0) throw new Error('amount must be a positive integer of micro-credits');
    if (amountMicro < this.minimumMicro(rail)) throw new Error(`minimum payout for ${rail} is ${this.minimumMicro(rail) / 1_000_000} credits ($${this.minimumMicro(rail) / 1_000_000})`);

    if (rail === 'credits') {
      // Nothing to do: credits already live in the account and can be spent.
      return { id: id('po'), accountId, amountMicro, rail, status: 'sent', createdAt: nowMs(), settledAt: nowMs() };
    }

    const adapter = this.adapters.get(rail);
    if (!adapter) throw new Error(`no adapter for rail ${rail}`);
    if (!address || !adapter.validateAddress(address)) throw new Error('invalid address for rail');

    const req: PayoutRequest = { id: id('po'), accountId, amountMicro, rail, address, status: 'pending', createdAt: nowMs() };

    // Debit first so the credits can't be double-spent while the rail is in flight.
    this.db.transaction(() => {
      this.ledger.charge(accountId, amountMicro, req.id);
      this.db
        .prepare('INSERT INTO payouts (id, account_id, amount_micro, rail, address, status, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(req.id, accountId, amountMicro, rail, address, 'pending', req.createdAt);
    })();

    try {
      const tx = await adapter.send(amountMicro, address);
      req.status = 'sent';
      req.txRef = tx;
      req.settledAt = nowMs();
      this.db.prepare("UPDATE payouts SET status='sent', tx_ref=?, settled_at=? WHERE id=?").run(tx, req.settledAt, req.id);
    } catch (err) {
      if (err instanceof PayoutPending) return req; // stays pending, credits stay debited
      req.status = 'failed';
      this.db.transaction(() => {
        this.db.prepare("UPDATE payouts SET status='failed' WHERE id=?").run(req.id);
        this.ledger.post(accountId, amountMicro, 'refund', req.id);
      })();
    }
    return req;
  }

  list(accountId: string): PayoutRequest[] {
    const rows = this.db.prepare('SELECT * FROM payouts WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(accountId) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: r.id as string,
      accountId: r.account_id as string,
      amountMicro: r.amount_micro as number,
      rail: r.rail as Rail,
      address: (r.address as string) ?? undefined,
      status: r.status as PayoutRequest['status'],
      txRef: (r.tx_ref as string) ?? undefined,
      createdAt: r.created_at as number,
      settledAt: (r.settled_at as number) ?? undefined,
    }));
  }
}
