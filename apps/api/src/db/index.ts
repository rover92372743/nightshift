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
  migrate(db);
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

// Columns added after the first release. CREATE TABLE IF NOT EXISTS won't add
// them to an existing file, so check and add. Keep this list in order.
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['jobs', 'scrubbed', 'INTEGER NOT NULL DEFAULT 0'],
  ['nodes', 'online_ms_24h', 'INTEGER NOT NULL DEFAULT 0'],
  ['nodes', 'uptime_day', 'INTEGER NOT NULL DEFAULT 0'],
];

function migrate(db: Db): void {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
