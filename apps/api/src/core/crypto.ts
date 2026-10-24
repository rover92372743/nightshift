// Ed25519 via tweetnacl. Node has it in webcrypto too, but tweetnacl runs
// identically in the browser worker, and a receipt verifier that works in
// both places is the whole point.

import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
export function fromB64u(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface KeyPair {
  publicKey: string;
  secretKey: Uint8Array;
}

export function sign(message: string, secretKey: Uint8Array): string {
  return b64u(nacl.sign.detached(new TextEncoder().encode(message), secretKey));
}

export function verify(message: string, sig: string, publicKey: string): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      fromB64u(sig),
      fromB64u(publicKey),
    );
  } catch {
    return false;
  }
}

/** Load the router key from disk, or make one. The file is the raw 64-byte secret, base64url. */
export function loadOrCreateRouterKey(file: string): KeyPair {
  if (fs.existsSync(file)) {
    const secretKey = fromB64u(fs.readFileSync(file, 'utf8').trim());
    const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
    return { publicKey: b64u(kp.publicKey), secretKey: kp.secretKey };
  }
  const kp = nacl.sign.keyPair();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, b64u(kp.secretKey), { mode: 0o600 });
  return { publicKey: b64u(kp.publicKey), secretKey: kp.secretKey };
}
