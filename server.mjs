// Production server for the Tappi API (the `src/app/api/*+api.ts` routes), for hosts like Render.
//
//   pnpm build:server   # expo export: API routes only → dist/server (no app screens are bundled)
//   pnpm serve          # applies database migrations, then serves /api on $PORT
//
// One long-running process on purpose: Stellar submissions are queued per account in memory
// (src/server/stellar/lock.ts) and AI voice clips live in memory for 5 minutes
// (src/server/ai/speech.ts). Run a single instance; serverless/multi-instance hosting breaks both.
import { existsSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';

// expo-server's ESM build uses extensionless imports Node can't resolve; its CommonJS build is fine.
const { createRequestHandler } = createRequire(import.meta.url)('expo-server/adapter/http');

const root = path.dirname(new URL(import.meta.url).pathname);
const build = path.join(root, 'dist', 'server');

if (!existsSync(build)) {
  console.error('[tappi] dist/server is missing. Run `pnpm build:server` first.');
  process.exit(1);
}
// The hosted disk is wiped on every deploy; a local PGlite database there would lose every wallet.
if (!process.env.DATABASE_URL) {
  console.error('[tappi] DATABASE_URL is not set. The hosted server needs Postgres (Neon).');
  process.exit(1);
}

await migrate(drizzle(neon(process.env.DATABASE_URL)), { migrationsFolder: path.join(root, 'drizzle') });
console.info('[tappi] database migrated');

const handle = createRequestHandler({ build, environment: process.env.NODE_ENV ?? 'production' });
const server = http.createServer((req, res) =>
  handle(req, res, (error) => {
    if (res.headersSent) return res.destroy(error);
    res.statusCode = error ? 500 : 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: error ? 'Something went wrong on the server.' : 'Not found' }));
    if (error) console.error('[tappi]', error);
  }),
);
// Voice replies wait up to ~15 s for Sahara; keep connections well above that.
server.requestTimeout = 120_000;
server.headersTimeout = 125_000;

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.info(`[tappi] API listening on :${port}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.info(`[tappi] ${signal}: closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
