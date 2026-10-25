// Operator endpoints. Everything here needs the admin key from the
// environment in an `x-admin-key` header; with no key configured the whole
// group answers 404 so a stock deployment exposes nothing extra.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Ctx } from '../app.js';
import { config } from '../config.js';
import { nowMs } from '../db/index.js';

function keyOk(req: FastifyRequest): boolean {
  const given = String(req.headers['x-admin-key'] ?? '');
  const want = config.adminKey;
  if (!want || !given || given.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

export function adminRoutes(ctx: Ctx): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', async (req, reply) => {
      if (!config.adminKey) {
        reply.code(404);
        throw new Error('not found');
      }
      if (!keyOk(req)) {
        reply.code(401);
        throw new Error('admin key required');
      }
    });

    /** Who's who. */
    app.get('/me', async () => ({ admin: true, router: ctx.routerKey.publicKey, now: nowMs() }));

    app.get('/accounts', async () => ({ accounts: ctx.ledger.accounts() }));

    /** Mint a key for a business, optionally with an opening balance. */
    app.post<{ Body: { label?: string; credits?: number } }>('/keys', async (req) => {
      const label = String(req.body?.label ?? 'unnamed key').slice(0, 64);
      const { accountId, apiKey } = ctx.ledger.createApiKey(label);
      const credits = Number(req.body?.credits ?? 0);
      if (credits > 0) ctx.ledger.post(accountId, Math.round(credits * 1_000_000), 'grant', 'opening balance');
      return { accountId, apiKey, label, balanceMicro: ctx.ledger.balance(accountId) };
    });

    /** Add credits. Same thing scripts/grant.mjs does, without stopping the API. */
    app.post<{ Body: { accountId?: string; credits?: number; note?: string } }>('/grant', async (req, reply) => {
      const accountId = String(req.body?.accountId ?? '');
      const credits = Number(req.body?.credits);
      if (!ctx.ledger.account(accountId)) {
        reply.code(404);
        return { error: { message: 'no such account' } };
      }
      if (!Number.isFinite(credits) || credits === 0 || Math.abs(credits) > 1_000_000) {
        reply.code(400);
        return { error: { message: 'credits must be a non-zero number' } };
      }
      const entry = ctx.ledger.post(accountId, Math.round(credits * 1_000_000), 'grant', String(req.body?.note ?? 'operator grant').slice(0, 120));
      return { entry, balanceMicro: ctx.ledger.balance(accountId) };
    });

    /** Inquiries from the pricing page. */
    app.get('/quotes', async () => ({
      quotes: ctx.db.prepare('SELECT id, company, email, need, created_at AS createdAt FROM quotes ORDER BY created_at DESC LIMIT 100').all(),
    }));

    /** Recent jobs across all accounts, content stripped. */
    app.get('/jobs', async () => ({ jobs: ctx.router.recentAll(50) }));
  };
}
