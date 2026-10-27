import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  port: Number(env('PORT', '8787')),
  host: env('HOST', '0.0.0.0'),
  /** SQLite file. ":memory:" is handy for tests. */
  dbPath: env('NIGHTSHIFT_DB', path.resolve(here, '../../../data/nightshift.db')),
  /** Where the router's ed25519 key lives. Generated on first boot if missing. */
  keyPath: env('NIGHTSHIFT_KEY', path.resolve(here, '../../../data/router.key')),
  /** Comma separated origins allowed to hit the API from a browser. */
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173').split(','),
  /** If set, the API also serves the built web app from this folder. */
  staticDir: env('NIGHTSHIFT_STATIC', '') ? path.resolve(process.cwd(), env('NIGHTSHIFT_STATIC', '')) : '',
  /** Requests per minute per IP for the public inference endpoint. */
  inferRpm: Number(env('INFER_RPM', '20')),
  /** Cloud/external tiers are off unless explicitly enabled. See docs/payouts-and-tiers.md. */
  externalEnabled: env('EXTERNAL_ENABLED', 'false') === 'true',
  /** Operator key for /v1/admin (grants, account list, quotes). Unset = admin routes are off. */
  adminKey: env('NIGHTSHIFT_ADMIN_KEY', ''),
  logLevel: env('LOG_LEVEL', 'info'),
  /** Log one line per HTTP request (includes the caller's IP). Off by default. */
  requestLogging: env('REQUEST_LOGGING', 'false') === 'true',
  /** Minutes to keep prompt and reply text after a job finishes. Hashes are kept forever. 0 keeps text forever. */
  contentRetentionMin: Number(env('CONTENT_RETENTION_MIN', '10')),
};
