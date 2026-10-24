import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const here = path.dirname(fileURLToPath(import.meta.url));

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

// Small helpers so route code reads like what it does and not like SQLite.

export function nowMs(): number {
  return Date.now();
}

export function id(prefix: string): string {
  // 16 bytes of randomness, base32-ish. Short enough to paste, long enough to not collide.
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return `${prefix}_${s}`;
}
