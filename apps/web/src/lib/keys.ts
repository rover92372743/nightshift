// Node identity lives in the browser. The secret never leaves localStorage;
// the router only ever sees the public half and signatures.

import nacl from 'tweetnacl';
import { canonical, type Receipt, type Signer } from '@nightshift/shared';

const KEY = 'nightshift.node.secret';

function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function loadOrCreateNodeKey(): Signer & { secret: string; reset(): void } {
  let secret: Uint8Array | null = null;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) secret = fromB64u(stored);
  } catch {
    /* private mode etc. */
  }
  const kp = secret ? nacl.sign.keyPair.fromSecretKey(secret) : nacl.sign.keyPair();
  if (!secret) {
    try {
      localStorage.setItem(KEY, b64u(kp.secretKey));
    } catch {
      /* ignore */
    }
  }
  return {
    publicKey: b64u(kp.publicKey),
    secret: b64u(kp.secretKey),
    sign: (msg: string) => b64u(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)),
    reset() {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

/** A signer for a key pasted from another machine. Not stored. */
export function importNodeKey(secretB64u: string): Signer | null {
  try {
    const sk = fromB64u(secretB64u);
    if (sk.length !== 64) return null;
    const kp = nacl.sign.keyPair.fromSecretKey(sk);
    return { publicKey: b64u(kp.publicKey), sign: (msg: string) => b64u(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)) };
  } catch {
    return null;
  }
}

function verify(msg: string, sig: string, pub: string): boolean {
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(msg), fromB64u(sig), fromB64u(pub));
  } catch {
    return false;
  }
}

/** Same checks the router does, run locally. Needs nothing from the network. */
export function verifyReceiptLocally(r: Receipt, expectedRouterKey?: string) {
  const canon = canonical(r.body);
  const nodeSignature = verify(canon, r.nodeSig, r.nodeKey);
  const routerSignature = verify(canon + '.' + r.nodeSig, r.routerSig, r.routerKey);
  return {
    valid: nodeSignature && routerSignature,
    nodeSignature,
    routerSignature,
    routerIsThisRouter: expectedRouterKey ? r.routerKey === expectedRouterKey : null,
    canonical: canon,
  };
}
