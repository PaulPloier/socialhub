import "server-only";
import path from "node:path";
import fs from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { env } from "../env";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

type Holder = { db?: Db; ready?: Promise<Db>; kind?: "pglite" | "postgres" };
const g = globalThis as unknown as { __socialhub_db?: Holder };
const holder: Holder = (g.__socialhub_db ??= {});

async function create(): Promise<Db> {
  const e = env();
  if (e.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: e.DATABASE_URL, max: 10 });
    const db = drizzle(pool, { schema }) as unknown as Db;
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db as never, { migrationsFolder: migrationsFolder() });
    holder.kind = "postgres";
    return db;
  }
  const dir = path.resolve(e.DATA_DIR, "pg");
  fs.mkdirSync(dir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(dir);
  const db = drizzle(client, { schema }) as unknown as Db;
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(db as never, { migrationsFolder: migrationsFolder() });
  holder.kind = "pglite";
  return db;
}

function migrationsFolder(): string {
  return path.resolve(process.cwd(), "drizzle");
}

/** Singleton-Datenbank (führt beim ersten Zugriff die Migrationen aus). */
export async function getDb(): Promise<Db> {
  if (holder.db) return holder.db;
  if (!holder.ready) {
    holder.ready = create().then((db) => {
      holder.db = db;
      return db;
    });
  }
  return holder.ready;
}

export function dbKind(): "pglite" | "postgres" | undefined {
  return holder.kind;
}

export { schema };
