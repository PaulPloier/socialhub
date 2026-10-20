import { defineConfig } from "drizzle-kit";

// Migrationen werden mit `npm run db:generate` aus dem Schema erzeugt und beim
// App-Start automatisch angewendet (PGlite und Postgres).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  ...(process.env.DATABASE_URL
    ? { dbCredentials: { url: process.env.DATABASE_URL } }
    : { driver: "pglite", dbCredentials: { url: `${process.env.DATA_DIR ?? "./data"}/pg` } }),
});
