import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '.env.local' });

// Neon when DATABASE_URL is set; otherwise the local PGlite database (stop `pnpm start` first).
export default process.env.DATABASE_URL
  ? defineConfig({
      schema: './src/server/db/schema.ts',
      out: './drizzle',
      dialect: 'postgresql',
      dbCredentials: { url: process.env.DATABASE_URL },
    })
  : defineConfig({
      schema: './src/server/db/schema.ts',
      out: './drizzle',
      dialect: 'postgresql',
      driver: 'pglite',
      dbCredentials: { url: './.data/pglite' },
    });
