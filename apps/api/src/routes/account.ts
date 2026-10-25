import type { FastifyPluginAsync } from 'fastify';
import type { Ctx } from '../app.js';
import { requester } from '../auth.js';
import { id, nowMs } from '../db/index.js';

export function accountRoutes(ctx: Ctx): FastifyPluginAsync {
  return async (app) => {
    const who = requester(ctx.ledger);

    app.get('/me', async (req, reply) => {
      const acct = who(req, reply);
      const a = ctx.ledger.account(acct);
      return {
        accountId: acct,
        kind: a?.kind ?? 'session',
        label: a?.label ?? null,
        balanceMicro: ctx.ledger.balance(acct),
        ledger: ctx.ledger.entries(acct, 30),
      };
    });

    // Quote requests from the pricing page. Read them with:
    //   sqlite3 data/nightshift.db 'select * from quotes order by created_at desc'
    app.post<{ Body: { company?: string; email?: string; need?: string } }>(
      '/quotes',
      { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
      async (req, reply) => {
        const b = req.body ?? {};
        const email = String(b.email ?? '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !String(b.need ?? '').trim()) {
          reply.code(400);
          return { error: { message: 'a work email and a description of the job are required' } };
        }
        ctx.db
          .prepare('INSERT INTO quotes (id, company, email, need, created_at) VALUES (?,?,?,?,?)')
          .run(id('q'), String(b.company ?? '').slice(0, 120), email.slice(0, 200), String(b.need).slice(0, 4000), nowMs());
        return { ok: true };
      },
    );

    // Keys are not self-serve. A business asks (the form on the pricing page
    // or the console's sign-in screen posts here), the operator mints one from
    // the console with `keys new`, and sends it over a channel they trust.
    app.post<{ Body: { company?: string; email?: string; need?: string } }>(
      '/access',
      { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
      async (req, reply) => {
        const b = req.body ?? {};
        const email = String(b.email ?? '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          reply.code(400);
          return { error: { message: 'a valid email is required' } };
        }
        ctx.db
          .prepare('INSERT INTO quotes (id, company, email, need, created_at) VALUES (?,?,?,?,?)')
          .run(id('q'), String(b.company ?? '').slice(0, 120), email.slice(0, 200), 'ACCESS REQUEST · ' + String(b.need ?? '').slice(0, 4000), nowMs());
        return { ok: true };
      },
    );
  };
}
