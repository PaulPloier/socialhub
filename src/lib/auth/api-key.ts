import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { env } from "../env";
import { newApiKey, safeEqual, sha256 } from "../crypto";

export interface ApiPrincipal {
  keyId: string;
  name: string;
}

/** Prüft einen Bearer-Token (MCP / REST). Bootstrap-Key aus ENV oder DB-Key. */
export async function verifyApiKey(token: string | undefined | null): Promise<ApiPrincipal | null> {
  if (!token) return null;
  const boot = env().MCP_API_KEY;
  if (boot && safeEqual(token, boot)) return { keyId: "env", name: "MCP_API_KEY (env)" };
  const db = await getDb();
  const hash = sha256(token);
  const row = await db.query.apiKeys.findFirst({ where: eq(schema.apiKeys.keyHash, hash) });
  if (!row) return null;
  await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.id));
  return { keyId: row.id, name: row.name };
}

export async function createApiKey(name: string): Promise<{ plain: string; id: string }> {
  const db = await getDb();
  const { plain, hash, prefix } = newApiKey();
  const id = crypto.randomUUID();
  await db.insert(schema.apiKeys).values({ id, name, keyHash: hash, prefix });
  return { plain, id };
}

export async function listApiKeys() {
  const db = await getDb();
  return db.query.apiKeys.findMany({ orderBy: (t, { desc }) => desc(t.createdAt) });
}

export async function deleteApiKey(id: string) {
  const db = await getDb();
  await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id));
}

export function bearerFromRequest(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
