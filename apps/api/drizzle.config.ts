import { defineConfig } from 'drizzle-kit';

// drizzle-kit reads DATABASE_URL from process.env at run time. No dotenv
// load here — local dev relies on the shell-loaded .env (or Bun's auto-load
// when invoked via `bun`); production secrets come from Fly Secrets.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: '../../migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
});
