import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';

import { config } from './config.js';
import { openDb, type Db } from './db/index.js';
import { loadOrCreateRouterKey, type KeyPair } from './core/crypto.js';
import { Ledger } from './core/ledger.js';
import { Live } from './core/live.js';
import { Nodes } from './core/nodes.js';
import { Router } from './core/router.js';
import { Payouts } from './core/payouts.js';
import { HEARTBEAT_MS } from '@docket/shared';

import { inferenceRoutes } from './routes/inference.js';
import { nodeRoutes } from './routes/nodes.js';
import { networkRoutes } from './routes/network.js';
import { accountRoutes } from './routes/account.js';

export interface Ctx {
  db: Db;
  ledger: Ledger;
  live: Live;
  nodes: Nodes;
  router: Router;
  payouts: Payouts;
  routerKey: KeyPair;
}

export function buildContext(opts: { dbPath?: string; keyPath?: string } = {}): Ctx {
  const db = openDb(opts.dbPath ?? config.dbPath);
  const routerKey = loadOrCreateRouterKey(opts.keyPath ?? config.keyPath);
  const live = new Live();
  const ledger = new Ledger(db);
  const nodes = new Nodes(db, live, ledger);
  const router = new Router(db, nodes, ledger, live, routerKey);
  const payouts = new Payouts(db, ledger);
  return { db, ledger, live, nodes, router, payouts, routerKey };
}

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Even with request logging on, keep addresses and auth material out of the log file.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-node-auth"]', 'req.remoteAddress', 'req.headers["user-agent"]'],
    },
    disableRequestLogging: !config.requestLogging,
    bodyLimit: 256 * 1024,
  });

  // Keep the raw body around so node signatures can be checked against the
  // exact bytes that were sent, not a re-serialisation.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  app.setErrorHandler((err: Error & { status?: number; statusCode?: number }, _req, reply) => {
    const status = err.status ?? err.statusCode ?? (reply.statusCode >= 400 ? reply.statusCode : 500);
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: { message: err.message, type: status >= 500 ? 'server_error' : 'invalid_request' } });
  });

  app.get('/health', async () => ({ ok: true, routerKey: ctx.routerKey.publicKey }));

  await app.register(inferenceRoutes(ctx), { prefix: '/v1' });
  await app.register(nodeRoutes(ctx), { prefix: '/v1' });
  await app.register(networkRoutes(ctx), { prefix: '/v1' });
  await app.register(accountRoutes(ctx), { prefix: '/v1' });

  if (config.staticDir) {
    await app.register(fastifyStatic, { root: path.resolve(config.staticDir), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/v1/')) return reply.code(404).send({ error: { message: 'not found' } });
      return reply.sendFile('index.html');
    });
  }

  // Housekeeping: offline nodes, expired leases, stats broadcast.
  const timer = setInterval(() => {
    for (const nodeId of ctx.nodes.reap()) ctx.router.releaseNodeJobs(nodeId);
    ctx.router.reapLeases();
    if (config.contentRetentionMin > 0) ctx.router.scrubContent(config.contentRetentionMin * 60_000);
  }, HEARTBEAT_MS / 2);
  app.addHook('onClose', async () => clearInterval(timer));

  return app;
}
