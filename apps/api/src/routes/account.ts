import type { FastifyPluginAsync } from 'fastify';
import type { Ctx } from '../app.js';
import { requester } from '../auth.js';

export function accountRoutes(ctx: Ctx): FastifyPluginAsync {
  return async (app) => {
    const who = requester(ctx.ledger);

    app.get('/me', async (req, reply) => {
      const acct = who(req, reply);
      return {
        accountId: acct,
        balanceMicro: ctx.ledger.balance(acct),
        ledger: ctx.ledger.entries(acct, 30),
      };
    });

    // Anyone can mint a key. It starts at zero; the operator tops it up
    // (scripts/grant.mjs) or you wire a payment flow in front of this.
    app.post<{ Body: { label?: string } }>(
      '/keys',
      { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
      async (req) => {
        const { accountId, apiKey } = ctx.ledger.createApiKey(String(req.body?.label ?? 'unnamed key').slice(0, 64));
        return { accountId, apiKey, note: 'store this; it is not shown again' };
      },
    );
  };
}
