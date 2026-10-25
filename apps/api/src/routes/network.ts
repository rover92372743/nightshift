import type { FastifyPluginAsync } from 'fastify';
import type { Ctx } from '../app.js';
import { networkStats } from '../core/stats.js';
import { toPublic } from '../core/nodes.js';
import { verify } from '../core/crypto.js';
import { canonical, type LiveEvent, type Receipt } from '@nightshift/shared';

export function networkRoutes(ctx: Ctx): FastifyPluginAsync {
  return async (app) => {
    app.get('/network', async () => ({ stats: networkStats(ctx.db), routerKey: ctx.routerKey.publicKey }));

    app.get('/router-key', async () => ({ publicKey: ctx.routerKey.publicKey, alg: 'ed25519' }));

    app.get('/receipts', async () => ({ receipts: ctx.router.latestReceipts(10) }));

    app.get<{ Params: { id: string } }>('/receipts/:id', async (req, reply) => {
      const r = ctx.router.receipt(req.params.id);
      if (!r) {
        reply.code(404);
        return { error: { message: 'receipt not found' } };
      }
      return { receipt: r, valid: checkReceipt(r, ctx.routerKey.publicKey) };
    });

    /**
     * Offline-style verification: send any receipt, we tell you whether the
     * signatures hold up. This runs the same checks the browser verifier
     * does; the endpoint exists so people with curl can do it too.
     */
    app.post<{ Body: { receipt: Receipt } }>('/receipts/verify', async (req, reply) => {
      const r = req.body?.receipt;
      if (!r?.body || !r.nodeSig || !r.routerSig) {
        reply.code(400);
        return { error: { message: 'receipt with body, nodeSig and routerSig required' } };
      }
      return checkReceipt(r, ctx.routerKey.publicKey);
    });

    // Live feed. Sends a snapshot on connect, then every event, plus stats every few seconds.
    app.get('/network/live', { websocket: true }, (socket) => {
      const send = (ev: LiveEvent) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(ev));
      };
      send({ t: 'hello', stats: networkStats(ctx.db), nodes: ctx.nodes.online().map(toPublic) });
      const off = ctx.live.on(send);
      const tick = setInterval(() => send({ t: 'stats', stats: networkStats(ctx.db) }), 4000);
      socket.on('close', () => {
        off();
        clearInterval(tick);
      });
      socket.on('error', () => {
        off();
        clearInterval(tick);
      });
    });
  };
}

export function checkReceipt(r: Receipt, ourRouterKey: string) {
  const canon = canonical(r.body);
  const nodeOk = verify(canon, r.nodeSig, r.nodeKey);
  const routerOk = verify(canon + '.' + r.nodeSig, r.routerSig, r.routerKey);
  const routerIsUs = r.routerKey === ourRouterKey;
  return {
    valid: nodeOk && routerOk,
    nodeSignature: nodeOk,
    routerSignature: routerOk,
    routerIsThisRouter: routerIsUs,
    canonical: canon,
  };
}
