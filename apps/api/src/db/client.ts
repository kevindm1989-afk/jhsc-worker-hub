import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env';
import { schema } from './schema';

// Lazy singleton — created on first call. Keeps the DATABASE_URL check off
// the import path so tests that never touch the DB don't need the secret
// in their environment. Production startup can force-construct via
// `getDb()` if/when we want strict fail-fast at boot.

let cached: ReturnType<typeof build> | null = null;

function build() {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to construct the database client');
  }
  const sql = postgres(env.DATABASE_URL);
  return drizzle(sql, { schema });
}

export function getDb() {
  if (!cached) {
    cached = build();
  }
  return cached;
}
