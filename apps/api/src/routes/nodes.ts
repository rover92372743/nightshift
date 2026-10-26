import type { FastifyPluginAsync } from 'fastify';
import type { Ctx } from '../app.js';
import { config } from '../config.js';
import { nodeAuth } from '../auth.js';
import { toPublic } from '../core/nodes.js';
import type { BenchResult, JobOutput, NodeCapabilities, NodeClass, ReceiptBody } from '@nightshift/shared';

interface RegisterBody {
  class: NodeClass;
  label: string;
  publicKey: string;
  capabilities: NodeCapabilities;
  lookupOnly?: boolean;
  benchmark?: BenchResult;
}

interface CompleteBody {
  output: JobOutput;
  receipt: ReceiptBody;
  nodeSig: string;
}

export function nodeRoutes(ctx: Ctx): FastifyPluginAsync {
  return async (app) => {
    const auth = nodeAuth(ctx.nodes);

    app.post(
      '/benchmark/ticket',
      { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
      async () => ({ ticket: ctx.nodes.issueTicket() }),
    );

    app.post<{ Body: RegisterBody }>(
      '/nodes/register',
      { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
      async (req, reply) => {
        const b = req.body;
        if (!b?.publicKey || !/^[A-Za-z0-9_-]{43}$/.test(b.publicKey)) {
          reply.code(400);
          return { error: { message: 'publicKey must be a base64url ed25519 public key' } };
        }
        if ((b.class === 'cloud' || b.class === 'external') && !config.externalEnabled) {
          reply.code(403);
          return { error: { message: 'cloud and external node classes are disabled on this router' } };
        }
        try {
          const node = ctx.nodes.register({
            class: b.class ?? 'browser',
            label: String(b.label ?? 'unnamed'),
            publicKey: b.publicKey,
            capabilities: b.capabilities,
            lookupOnly: Boolean(b.lookupOnly),
            benchmark: b.benchmark,
          });
          if (!b.lookupOnly) ctx.router.dispatch();
          return { node, routerKey: ctx.routerKey.publicKey };
        } catch (err) {
          reply.code(400);
          return { error: { message: (err as Error).message } };
        }
      },
    );

    app.post<{ Params: { id: string }; Body: { busy?: boolean } }>('/nodes/:id/heartbeat', async (req, reply) => {
      const nodeId = auth(req, reply);
      const ok = ctx.nodes.heartbeat(nodeId, Boolean(req.body?.busy));
      if (!ok) {
        reply.code(404);
        return { error: { message: 'unknown node' } };
      }
      if (!req.body?.busy) ctx.router.dispatch();
      return { ok: true, serverTime: Date.now() };
    });

    app.post<{ Params: { id: string } }>('/nodes/:id/claim', async (req, reply) => {
      const nodeId = auth(req, reply);
      ctx.nodes.heartbeat(nodeId, false);
      ctx.router.dispatch();
      const job = ctx.router.claim(nodeId);
      if (!job) {
        reply.code(204);
        return;
      }
      return { job };
    });

    app.post<{ Params: { id: string; jobId: string }; Body: CompleteBody }>(
      '/nodes/:id/jobs/:jobId/complete',
      async (req, reply) => {
        const nodeId = auth(req, reply);
        const b = req.body;
        if (!b?.output || !b.receipt || !b.nodeSig) {
          reply.code(400);
          return { error: { message: 'output, receipt and nodeSig are required' } };
        }
        const receipt = await ctx.router.complete(nodeId, req.params.jobId, b.output, b.receipt, b.nodeSig);
        return { receipt };
      },
    );

    app.post<{ Params: { id: string; jobId: string }; Body: { reason?: string } }>(
      '/nodes/:id/jobs/:jobId/fail',
      async (req, reply) => {
        const nodeId = auth(req, reply);
        ctx.router.fail(nodeId, req.params.jobId, String(req.body?.reason ?? 'node reported failure'));
        return { ok: true };
      },
    );

    // Node's own view: earnings, counters, recent jobs. Signed, so only the key holder sees it.
    app.get<{ Params: { id: string } }>('/nodes/:id/me', async (req, reply) => {
      const nodeId = auth(req, reply);
      const node = ctx.nodes.get(nodeId)!;
      const acct = ctx.nodes.accountId(nodeId);
      return {
        node,
        uptimeMs24h: ctx.router.nodeUptime24h(nodeId),
        payoutMinMicro: ctx.payouts.minimumMicro(),
        balanceMicro: ctx.ledger.balance(acct),
        ledger: ctx.ledger.entries(acct, 30),
        jobs: ctx.router.recentForNode(nodeId, 20),
        payouts: ctx.payouts.list(acct),
      };
    });

    app.post<{ Params: { id: string }; Body: { amountMicro: number; address?: string } }>(
      '/nodes/:id/payouts',
      { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
      async (req, reply) => {
        const nodeId = auth(req, reply);
        const acct = ctx.nodes.accountId(nodeId);
        try {
          const p = ctx.payouts.request(acct, Number(req.body?.amountMicro), req.body?.address);
          return { payout: p };
        } catch (err) {
          reply.code(400);
          return { error: { message: (err as Error).message } };
        }
      },
    );

    // Public: what's on the network. No keys, no earnings.
    app.get('/nodes', async () => ({ nodes: ctx.nodes.online().map(toPublic) }));
    app.get<{ Params: { id: string } }>('/nodes/:id', async (req, reply) => {
      const node = ctx.nodes.get(req.params.id);
      if (!node) {
        reply.code(404);
        return { error: { message: 'unknown node' } };
      }
      return { node: toPublic(node) };
    });
  };
}
