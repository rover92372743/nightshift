// Two kinds of caller.
//
// Requesters are either an API key (Authorization: Bearer ns_...) or an
// anonymous browser session identified by a cookie we set on first contact.
// Sessions get a small free allowance; keys start empty and are topped up by
// the operator (see scripts/grant.mjs).
//
// Nodes authenticate by signing each request with the ed25519 key they
// registered. No shared secrets, nothing to leak from the DB.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { sha256Hex, verify } from './core/crypto.js';
import type { Ledger } from './core/ledger.js';
import type { Nodes } from './core/nodes.js';

const COOKIE = 'nightshift_sid';
const SKEW_MS = 60_000;

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Resolve who is asking. Creates a session (and sets the cookie) if there's nothing else. */
export function requester(ledger: Ledger) {
  return (req: FastifyRequest, reply: FastifyReply): string => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const acct = ledger.accountForKey(auth.slice(7).trim());
      if (!acct) {
        reply.code(401);
        throw new Error('invalid api key');
      }
      return acct;
    }
    let sid = readCookie(req, COOKIE);
    if (!sid || !/^sess_[A-Za-z0-9_-]{20,}$/.test(sid)) {
      sid = 'sess_' + randomBytes(18).toString('base64url');
      const secure = req.protocol === 'https' ? '; Secure' : '';
      reply.header('set-cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    }
    return ledger.ensureSession(sid);
  };
}

/**
 * Node request signature. Header `x-node-auth: <ts>.<sig>` where sig is
 * ed25519 over `${ts}.${METHOD}.${path}.${sha256(rawBody or "")}`.
 */
export function nodeAuth(nodes: Nodes) {
  return (req: FastifyRequest, reply: FastifyReply): string => {
    const nodeId = (req.params as { id?: string }).id;
    const header = req.headers['x-node-auth'];
    if (!nodeId || typeof header !== 'string') {
      reply.code(401);
      throw new Error('missing node auth');
    }
    const [tsRaw, sig] = header.split('.');
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SKEW_MS || !sig) {
      reply.code(401);
      throw new Error('stale or malformed node auth');
    }
    const node = nodes.get(nodeId);
    if (!node) {
      reply.code(404);
      throw new Error('unknown node');
    }
    const bodyHash = sha256Hex(req.rawBody ?? '');
    const path = req.url.split('?')[0];
    const msg = `${ts}.${req.method}.${path}.${bodyHash}`;
    if (!verify(msg, sig, node.publicKey)) {
      reply.code(401);
      throw new Error('bad node signature');
    }
    return nodeId;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}
