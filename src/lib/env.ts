import { z } from "zod";

/**
 * Zentrale, validierte Konfiguration. Wird lazy gelesen, damit Build-Zeit
 * (ohne Secrets) und Laufzeit sauber getrennt sind.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Öffentliche Basis-URL der App (ohne Slash am Ende). Wird für OAuth-Redirects
  // und öffentliche Medien-URLs (Instagram/Facebook/TikTok ziehen Videos per URL) benötigt.
  APP_URL: z.string().url().default("http://localhost:3000"),

  // Login der Web-Oberfläche (Single-Tenant Agentur-Login) und Session-Signatur.
  AUTH_PASSWORD: z.string().min(8).optional(),
  AUTH_SECRET: z.string().min(16).optional(),

  // 32 Byte, base64 oder hex. Verschlüsselt alle Access-/Refresh-Tokens in der DB.
  ENCRYPTION_KEY: z.string().min(32).optional(),

  // Postgres. Fehlt die URL, läuft lokal ein eingebettetes PGlite in DATA_DIR/pg.
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default("./data"),

  // Medien-Ablage: lokal (DATA_DIR/media) oder S3-kompatibel.
  MEDIA_STORAGE: z.enum(["local", "s3"]).default("local"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),

  // Worker im selben Prozess wie Next starten (Pflicht bei PGlite, optional bei Postgres).
  RUN_WORKER_IN_APP: z.enum(["true", "false"]).optional(),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(60),

  // Bootstrap-API-Key für den MCP-Server (weitere Keys werden in der UI erzeugt).
  MCP_API_KEY: z.string().min(16).optional(),

  // Plattform-Apps
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_VERSION: z.string().default("v23.0"),
  META_CONFIG_ID: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),

  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_VERSION: z.string().default("202509"),

  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),

  // Optional: Claude schreibt Report-Texte direkt in der App (sonst über MCP).
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  // Leere Werte aus der .env (z. B. "DATABASE_URL=") zählen als "nicht gesetzt".
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Ungültige Umgebungsvariablen: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache() {
  cached = null;
}

export function workerRunsInApp(): boolean {
  const e = env();
  if (e.RUN_WORKER_IN_APP) return e.RUN_WORKER_IN_APP === "true";
  return !e.DATABASE_URL; // PGlite erlaubt nur einen Prozess
}

export type NetworkKey = "facebook" | "instagram" | "youtube" | "tiktok" | "linkedin" | "x";

export function configuredNetworks(): Record<NetworkKey, boolean> {
  const e = env();
  const meta = !!(e.META_APP_ID && e.META_APP_SECRET);
  return {
    facebook: meta,
    instagram: meta,
    youtube: !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
    tiktok: !!(e.TIKTOK_CLIENT_KEY && e.TIKTOK_CLIENT_SECRET),
    linkedin: !!(e.LINKEDIN_CLIENT_ID && e.LINKEDIN_CLIENT_SECRET),
    x: !!(e.X_CLIENT_ID && e.X_CLIENT_SECRET),
  };
}
