import "server-only";
import { eq, lt } from "drizzle-orm";
import { getDb, schema } from "../db";
import { env } from "../env";
import { decrypt, encrypt, pkceChallenge, pkceVerifier, randomToken } from "../crypto";
import { connectorsForProvider } from "../connectors/registry";
import type { AccountCandidate, OAuthProvider } from "../connectors/types";
import { upsertFromCandidates } from "../services/connections";
import { enqueue } from "../jobs/queue";

const STATE_TTL_MS = 15 * 60 * 1000;
const PKCE_PROVIDERS: OAuthProvider[] = ["tiktok", "x"];

export function redirectUri(provider: OAuthProvider): string {
  return `${env().APP_URL}/api/oauth/${provider}/callback`;
}

/** Erzeugt State (+ PKCE) und die Autorisierungs-URL des Providers. */
export async function startOAuth(brandId: string, provider: OAuthProvider, returnTo?: string): Promise<string> {
  const connectors = connectorsForProvider(provider);
  const connector = connectors[0];
  if (!connector) throw new Error(`Unbekannter Provider ${provider}`);
  if (!connector.configured()) throw new Error(`${provider} ist nicht konfiguriert (Client-ID/Secret in .env fehlen).`);
  const db = await getDb();
  await db.delete(schema.oauthStates).where(lt(schema.oauthStates.createdAt, new Date(Date.now() - STATE_TTL_MS)));
  const state = randomToken(24);
  const verifier = PKCE_PROVIDERS.includes(provider) ? pkceVerifier() : null;
  await db.insert(schema.oauthStates).values({ state, brandId, provider, codeVerifier: verifier, returnTo: returnTo ?? null });
  return connector.authorizationUrl({
    state,
    redirectUri: redirectUri(provider),
    codeChallenge: verifier ? pkceChallenge(verifier) : undefined,
  });
}

export interface CallbackResult {
  brandId: string;
  /** Token zum Abruf der Kandidaten auf der Auswahlseite */
  selectionToken: string;
  candidates: AccountCandidate[];
}

/** Tauscht den Code, holt alle Konten und legt sie verschlüsselt zur Auswahl ab. */
export async function handleCallback(provider: OAuthProvider, params: { code?: string; state?: string; error?: string; error_description?: string }): Promise<CallbackResult> {
  if (params.error) throw new Error(`${provider}: ${params.error} ${params.error_description ?? ""}`.trim());
  if (!params.code || !params.state) throw new Error("OAuth-Antwort ohne code/state.");
  const db = await getDb();
  const st = await db.query.oauthStates.findFirst({ where: eq(schema.oauthStates.state, params.state) });
  if (!st || st.provider !== provider) throw new Error("Ungültiger oder abgelaufener OAuth-State. Bitte erneut verbinden.");
  await db.delete(schema.oauthStates).where(eq(schema.oauthStates.state, params.state));
  if (st.createdAt.getTime() < Date.now() - STATE_TTL_MS) throw new Error("OAuth-State abgelaufen. Bitte erneut verbinden.");
  const connector = connectorsForProvider(provider)[0];
  const candidates = await connector.exchangeCode({ code: params.code, redirectUri: redirectUri(provider), codeVerifier: st.codeVerifier ?? undefined });
  if (candidates.length === 0) {
    throw new Error(
      provider === "meta"
        ? "Keine Facebook-Seite gefunden. Der Nutzer braucht Vollzugriff auf mindestens eine Seite; Instagram muss als Business-/Creator-Konto mit der Seite verknüpft sein."
        : "Keine verbindbaren Konten gefunden.",
    );
  }
  const selectionToken = randomToken(24);
  await db.insert(schema.oauthCandidates).values({ id: selectionToken, brandId: st.brandId, provider, payloadEnc: encrypt(JSON.stringify(candidates)) });
  return { brandId: st.brandId, selectionToken, candidates };
}

export async function loadCandidates(selectionToken: string): Promise<{ brandId: string; provider: OAuthProvider; candidates: AccountCandidate[] } | null> {
  const db = await getDb();
  const row = await db.query.oauthCandidates.findFirst({ where: eq(schema.oauthCandidates.id, selectionToken) });
  if (!row || row.createdAt.getTime() < Date.now() - STATE_TTL_MS) return null;
  const candidates = JSON.parse(decrypt(row.payloadEnc)) as AccountCandidate[];
  return { brandId: row.brandId, provider: row.provider as OAuthProvider, candidates };
}

/** Übernimmt die ausgewählten Konten als Verbindungen und startet den ersten Sync. */
export async function connectSelected(selectionToken: string, keys: string[]): Promise<{ brandId: string; connected: number }> {
  const loaded = await loadCandidates(selectionToken);
  if (!loaded) throw new Error("Auswahl abgelaufen. Bitte erneut verbinden.");
  const chosen = loaded.candidates.filter((c) => keys.includes(`${c.network}:${c.externalId}`));
  const rows = await upsertFromCandidates(loaded.brandId, chosen);
  const db = await getDb();
  await db.delete(schema.oauthCandidates).where(eq(schema.oauthCandidates.id, selectionToken));
  for (const r of rows) {
    await enqueue("sync.all", { connectionId: r.id }, { uniqueKey: `sync:all:${r.id}` });
  }
  return { brandId: loaded.brandId, connected: rows.length };
}
