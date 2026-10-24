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
  dbPath: env('DOCKET_DB', path.resolve(here, '../../../data/docket.db')),
  /** Where the router's ed25519 key lives. Generated on first boot if missing. */
  keyPath: env('DOCKET_KEY', path.resolve(here, '../../../data/router.key')),
  /** Comma separated origins allowed to hit the API from a browser. */
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173').split(','),
  /** If set, the API also serves the built web app from this folder. */
  staticDir: env('DOCKET_STATIC', ''),
  /** Requests per minute per IP for the public inference endpoint. */
  inferRpm: Number(env('INFER_RPM', '20')),
  /** Cloud/external tiers are off unless explicitly enabled. See docs/payouts-and-tiers.md. */
  externalEnabled: env('EXTERNAL_ENABLED', 'false') === 'true',
  logLevel: env('LOG_LEVEL', 'info'),
};
