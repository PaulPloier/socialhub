import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Connection, Network } from "../db/schema";
import { decrypt, encrypt } from "../crypto";
import { connectorFor } from "../connectors/registry";
import { ConnectorHttpError } from "../connectors/http";
import type { AccountCandidate, ConnectionContext, TokenSet } from "../connectors/types";

export function toContext(c: Connection): ConnectionContext {
  return {
    id: c.id,
    brandId: c.brandId,
    network: c.network,
    externalId: c.externalId,
    name: c.name,
    accessToken: decrypt(c.accessTokenEnc),
    refreshToken: c.refreshTokenEnc ? decrypt(c.refreshTokenEnc) : null,
    tokenExpiresAt: c.tokenExpiresAt,
    scopes: c.scopes ?? [],
    meta: { ...(c.meta ?? {}), username: c.username ?? undefined },
  };
}

export async function getConnection(id: string): Promise<Connection | undefined> {
  const db = await getDb();
  return db.query.connections.findFirst({ where: eq(schema.connections.id, id) });
}

export async function listConnections(brandId?: string): Promise<Connection[]> {
  const db = await getDb();
  return db.query.connections.findMany({
    where: brandId ? eq(schema.connections.brandId, brandId) : undefined,
    orderBy: (t, { asc }) => [asc(t.network), asc(t.name)],
  });
}

/** Legt Verbindungen aus OAuth-Kandidaten an oder aktualisiert bestehende. */
export async function upsertFromCandidates(brandId: string, candidates: AccountCandidate[]): Promise<Connection[]> {
  const db = await getDb();
  const out: Connection[] = [];
  for (const c of candidates) {
    const values = {
      name: c.name,
      username: c.username ?? null,
      pictureUrl: c.pictureUrl ?? null,
      accessTokenEnc: encrypt(c.tokens.accessToken),
      refreshTokenEnc: c.tokens.refreshToken ? encrypt(c.tokens.refreshToken) : null,
      tokenExpiresAt: c.tokens.expiresAt ?? null,
      scopes: c.tokens.scopes ?? [],
      status: "active" as const,
      statusMessage: null,
      meta: c.meta ?? {},
      updatedAt: new Date(),
    };
    const existing = await db.query.connections.findFirst({
      where: and(eq(schema.connections.brandId, brandId), eq(schema.connections.network, c.network), eq(schema.connections.externalId, c.externalId)),
    });
    if (existing) {
      const [row] = await db.update(schema.connections).set(values).where(eq(schema.connections.id, existing.id)).returning();
      out.push(row);
    } else {
      const [row] = await db
        .insert(schema.connections)
        .values({ id: crypto.randomUUID(), brandId, network: c.network, externalId: c.externalId, ...values })
        .returning();
      out.push(row);
    }
  }
  return out;
}

export async function saveTokens(id: string, tokens: TokenSet): Promise<void> {
  const db = await getDb();
  await db
    .update(schema.connections)
    .set({
      accessTokenEnc: encrypt(tokens.accessToken),
      ...(tokens.refreshToken !== undefined ? { refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null } : {}),
      ...(tokens.expiresAt !== undefined ? { tokenExpiresAt: tokens.expiresAt } : {}),
      status: "active",
      statusMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.connections.id, id));
}

export async function setStatus(id: string, status: Connection["status"], message?: string | null): Promise<void> {
  const db = await getDb();
  await db
    .update(schema.connections)
    .set({ status, statusMessage: message ?? null, updatedAt: new Date() })
    .where(eq(schema.connections.id, id));
}

export async function deleteConnection(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(schema.connections).where(eq(schema.connections.id, id));
}

/**
 * Liefert einen Laufzeit-Kontext mit gültigem Token. Läuft das Token in < 10 Minuten
 * ab (oder ist abgelaufen), wird es erneuert. Schlägt das fehl, wird die Verbindung
 * als "reauth_required" markiert.
 */
export async function freshContext(conn: Connection): Promise<ConnectionContext> {
  const ctx = toContext(conn);
  const connector = connectorFor(conn.network);
  const soon = Date.now() + 10 * 60 * 1000;
  if (ctx.tokenExpiresAt && ctx.tokenExpiresAt.getTime() < soon) {
    try {
      const refreshed = await connector.refreshTokens(ctx);
      if (refreshed) {
        await saveTokens(conn.id, refreshed);
        return { ...ctx, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? ctx.refreshToken, tokenExpiresAt: refreshed.expiresAt ?? null };
      }
      if (ctx.tokenExpiresAt.getTime() < Date.now()) {
        await setStatus(conn.id, "reauth_required", "Token abgelaufen, bitte neu verbinden.");
        throw new Error(`Token für ${conn.network}/${conn.name} ist abgelaufen. Bitte neu verbinden.`);
      }
    } catch (err) {
      await setStatus(conn.id, "reauth_required", `Token-Refresh fehlgeschlagen: ${(err as Error).message}`.slice(0, 500));
      throw err;
    }
  }
  return ctx;
}

/** Fehler nach einem API-Aufruf einordnen und Verbindungsstatus setzen. */
export async function handleConnectorError(conn: Connection, err: unknown): Promise<{ retry: boolean }> {
  if (err instanceof ConnectorHttpError && err.isAuthError) {
    await setStatus(conn.id, "reauth_required", `Zugriff verweigert (${err.status}): ${err.message}`.slice(0, 500));
    return { retry: false };
  }
  await setStatus(conn.id, "error", (err as Error).message?.slice(0, 500) ?? "Unbekannter Fehler");
  return { retry: true };
}

export function networkLabel(network: Network): string {
  return connectorFor(network).label;
}
