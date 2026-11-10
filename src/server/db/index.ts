import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { PGlite } from '@electric-sql/pglite';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Two backends, one schema (as in Mint):
 *   DATABASE_URL=postgres://…  → Neon over HTTP
 *   DATABASE_URL unset         → PGlite: real Postgres in-process, stored in .data/pglite (or PGLITE_DIR)
 */
/** PGLITE_DIR points a second dev server at another database (e.g. a copy, for testing). */
export const LOCAL_DB_DIR = process.env.PGLITE_DIR || path.join(process.cwd(), '.data', 'pglite');
export const isLocalDb = () => !process.env.DATABASE_URL;

// On globalThis so Fast Refresh and separately bundled routes share one handle — PGlite's data
// directory may only be opened once per process.
const store = globalThis as typeof globalThis & {
  // A promise in servers started before this file changed; awaiting covers both.
  __tappiDb?: Db | Promise<Db>;
  __tappiMigrated?: { latest: string; done: Promise<unknown> };
};
const MIGRATIONS = path.join(process.cwd(), 'drizzle');

/** Opens the database (and, locally, applies any new migrations). Safe to call repeatedly. */
export async function db(): Promise<Db> {
  if (!isLocalDb()) return (store.__tappiDb ??= drizzleNeon(neon(process.env.DATABASE_URL!), { schema }) as unknown as Db);
  if (!store.__tappiDb) {
    mkdirSync(path.dirname(LOCAL_DB_DIR), { recursive: true });
    store.__tappiDb = drizzlePglite(new (loadPglite())(LOCAL_DB_DIR), { schema }) as unknown as Db;
  }
  const local = await store.__tappiDb;
  // Re-checked on every call so a new migration applies without restarting `pnpm start`.
  const latest = latestMigration();
  if (store.__tappiMigrated?.latest !== latest) {
    const done = migrate(local as never, { migrationsFolder: MIGRATIONS }).then(
      () => console.info(`[tappi] local database ready at ${path.relative(process.cwd(), LOCAL_DB_DIR)} (${latest})`),
      (error) => {
        store.__tappiMigrated = undefined;
        throw error;
      },
    );
    store.__tappiMigrated = { latest, done };
  }
  await store.__tappiMigrated.done;
  return local;
}

function latestMigration(): string {
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'));
  return journal.entries.at(-1)?.tag ?? 'none';
}

/**
 * PGlite reads its WASM and data files from next to its own module, which breaks once Metro
 * bundles it into an API route. Load it with Node's require from node_modules instead (Mint does
 * the same with Next's serverExternalPackages).
 */
function loadPglite(): typeof PGlite {
  const nodeRequire = createRequire(path.join(process.cwd(), 'package.json'));
  return nodeRequire('@electric-sql/pglite').PGlite;
}

export { schema };
