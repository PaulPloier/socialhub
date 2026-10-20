import type { z } from "zod";
import type { Network } from "../db/schema";

export type { Network };

/** Welche OAuth-App hinter einem Netzwerk steht (Facebook + Instagram teilen sich Meta). */
export type OAuthProvider = "meta" | "google" | "tiktok" | "linkedin" | "x";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
}

/** Ein Konto, das nach dem OAuth-Login zur Auswahl steht (Seite, Kanal, Organisation ...). */
export interface AccountCandidate {
  network: Network;
  externalId: string;
  name: string;
  username?: string | null;
  pictureUrl?: string | null;
  tokens: TokenSet;
  meta?: Record<string, unknown>;
}

export interface MetricPoint {
  metric: string;
  date: string; // YYYY-MM-DD
  value: number;
}

export interface PostRecord {
  externalId: string;
  type: string;
  title?: string | null;
  caption?: string | null;
  permalink?: string | null;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  publishedAt: Date;
  raw?: unknown;
  metrics: Record<string, number>;
}

export interface AudienceRow {
  dimension: string; // z. B. age_gender, country, city, traffic_source, device
  key: string;
  value: number;
}

export interface SyncRange {
  since: Date;
  until: Date;
}

/** Entschlüsselter Laufzeit-Kontext einer Verbindung. */
export interface ConnectionContext {
  id: string;
  brandId: string;
  network: Network;
  externalId: string;
  name: string;
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  scopes: string[];
  meta: Record<string, unknown>;
}

export interface PublishInput {
  /** Lokaler Dateipfad (für Chunk-Uploads) */
  filePath: string;
  /** Öffentlich erreichbare URL (für Plattformen, die per URL ziehen) */
  publicUrl: string;
  mimeType: string;
  sizeBytes: number;
  /** Beschreibung / Caption / Tweet-Text */
  text: string;
  /** Titel (YouTube, TikTok, LinkedIn-Medientitel) */
  title?: string | null;
  /** Netzwerkspezifische Optionen, validiert gegen publishOptionsSchema */
  options: Record<string, unknown>;
}

export interface PublishResult {
  externalId: string;
  permalink?: string | null;
  /** "processing": Plattform verarbeitet noch, Status später erneut prüfen */
  status: "published" | "processing";
  raw?: unknown;
}

export type MetricAggregation = "sum" | "last" | "avg";

export interface MetricDef {
  key: string;
  label: string;
  aggregation: MetricAggregation;
  description?: string;
}

export interface Connector {
  network: Network;
  provider: OAuthProvider;
  label: string;
  scopes: string[];
  /** Ist die Plattform-App konfiguriert (Client-ID/Secret vorhanden)? */
  configured(): boolean;
  authorizationUrl(p: { state: string; redirectUri: string; codeChallenge?: string }): string;
  /** Tauscht den Code und liefert alle verbindbaren Konten (kann mehrere Netzwerke enthalten, z. B. Meta). */
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string }): Promise<AccountCandidate[]>;
  /** Erneuert Tokens, wenn das Netzwerk das unterstützt. null = nicht nötig/möglich. */
  refreshTokens(ctx: ConnectionContext): Promise<TokenSet | null>;
  syncAccount(ctx: ConnectionContext, range: SyncRange): Promise<MetricPoint[]>;
  syncPosts(ctx: ConnectionContext, range: SyncRange): Promise<PostRecord[]>;
  syncAudience(ctx: ConnectionContext): Promise<AudienceRow[]>;
  publishVideo(ctx: ConnectionContext, input: PublishInput): Promise<PublishResult>;
  /** Für asynchrone Verarbeitung (TikTok, IG-Container, YouTube-Processing). */
  checkPublishStatus?(ctx: ConnectionContext, result: PublishResult): Promise<PublishResult>;
  publishOptionsSchema: z.ZodObject<z.ZodRawShape>;
  accountMetrics: MetricDef[];
  postMetrics: MetricDef[];
  audienceDimensions: string[];
  /** Hinweise/Einschränkungen (werden in UI und MCP angezeigt). */
  notes: string[];
}
