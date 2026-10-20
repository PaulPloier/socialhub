# SocialHub

Social-Media-Analytics, Video-Publishing und eine MCP-Schnittstelle, über die Claude die App komplett steuert.

- **Konten verbinden**: Facebook-Seiten, Instagram (Business/Creator), YouTube, TikTok, LinkedIn-Unternehmensseiten, X. OAuth läuft im Popup direkt bei der Plattform, Tokens werden verschlüsselt gespeichert und automatisch erneuert.
- **Analytics**: alles, was die jeweilige API hergibt. Tages-Zeitreihen (Views, Reichweite, Follower, Interaktionen …), Beiträge mit Metriken (Views, Likes, Kommentare, Shares, Saves, Wiedergabezeit …), Zielgruppen (Alter/Geschlecht, Länder, Städte, Traffic-Quellen, Geräte, Branchen …).
- **Publishing**: Videos hochladen und sofort oder geplant auf mehrere Konten veröffentlichen, mit allen netzwerkspezifischen Optionen (Reel/Story, Privatsphäre, Tags, Kategorie, Kommentare/Duet/Stitch, Sichtbarkeit …).
- **MCP-Server**: jede Funktion ist ein Tool. Claude kann Daten synchronisieren, Reports schreiben und speichern, Videos importieren und veröffentlichen. Beispiel: „Hol die neuesten Analytics für f0under.daily, schreib einen Bericht und lade in der Zwischenzeit das Video XYZ auf Instagram hoch, mit passender Beschreibung.“

## Stack

Next.js 16 (App Router, Server Actions), TypeScript, Tailwind 4, Drizzle ORM mit Postgres-Dialekt (lokal eingebettetes **PGlite** ohne Installation, produktiv echtes Postgres), DB-basierte Job-Queue (Sync, Token-Refresh, Publishing), `mcp-handler` + MCP SDK v2, AES-256-GCM-Token-Verschlüsselung, Recharts.

## Schnellstart (lokal)

```bash
cd socialhub
npm install
npm run setup        # erzeugt .env mit Login-Passwort, Secrets und MCP-Key
npm run dev          # http://localhost:3000
```

Beim ersten Start wird die Datenbank unter `./data/pg` angelegt und migriert. Der Job-Worker läuft im selben Prozess.

Danach in `.env` die Plattform-Zugangsdaten eintragen (siehe unten) und die App neu starten. Ohne Zugangsdaten läuft die App, zeigt aber „nicht konfiguriert“ bei den Verbinden-Buttons.

### Öffentliche URL (wichtig für OAuth und Instagram/Facebook)

Alle Plattformen verlangen HTTPS-Redirect-URIs, und Instagram/Facebook holen Videos per öffentlicher URL ab. Für die lokale Entwicklung einen Tunnel starten und `APP_URL` darauf setzen:

```bash
ngrok http 3000          # oder: cloudflared tunnel --url http://localhost:3000
```

```
APP_URL=https://abc123.ngrok-free.app
```

Die Redirect-URIs lauten dann `https://abc123.ngrok-free.app/api/oauth/<provider>/callback` (angezeigt unter Einstellungen).

## Plattform-Apps einrichten

| Provider | Konsole | Produkte / APIs | Redirect-URI | Env |
|---|---|---|---|---|
| Meta (Facebook + Instagram) | developers.facebook.com | Facebook Login (for Business), Instagram Graph API | `{APP_URL}/api/oauth/meta/callback` | `META_APP_ID`, `META_APP_SECRET`, optional `META_CONFIG_ID` |
| Google (YouTube) | console.cloud.google.com | YouTube Data API v3, YouTube Analytics API, OAuth-Client (Web) | `{APP_URL}/api/oauth/google/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| TikTok | developers.tiktok.com | Login Kit, Display API, Content Posting API | `{APP_URL}/api/oauth/tiktok/callback` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` |
| LinkedIn | linkedin.com/developers | Community Management API (Zugang beantragen) | `{APP_URL}/api/oauth/linkedin/callback` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| X | developer.x.com | OAuth 2.0, Confidential Client, mind. Basic-Tier | `{APP_URL}/api/oauth/x/callback` | `X_CLIENT_ID`, `X_CLIENT_SECRET` |

Berechtigungen, die die App anfordert:

- **Meta**: `pages_show_list, pages_read_engagement, pages_read_user_content, pages_manage_posts, pages_manage_engagement, read_insights, instagram_basic, instagram_manage_insights, instagram_content_publish, instagram_manage_comments, business_management`. Für fremde Konten (Kunden) ist Meta App Review + Business-Verifizierung nötig; für eigene Konten reicht der Entwicklungsmodus mit Test-/Admin-Nutzern.
- **Google**: `youtube.readonly, yt-analytics.readonly, youtube.upload, youtube.force-ssl`. Für andere Nutzer als Testnutzer ist die OAuth-Consent-Screen-Verifizierung nötig. Standard-Quota 10.000 Einheiten/Tag.
- **TikTok**: `user.info.basic, user.info.profile, user.info.stats, video.list, video.publish, video.upload`. Vor dem Audit veröffentlicht TikTok nur privat (`SELF_ONLY`), max. 5 Nutzer/Tag.
- **LinkedIn**: `openid, profile, r_organization_social, w_organization_social, rw_organization_admin, r_organization_admin`.
- **X**: `tweet.read, tweet.write, users.read, offline.access, media.write`.

Was die APIs nicht liefern (deshalb bleibt es in der App leer): TikTok und X haben keine Follower-Demografie und keine Tages-Zeitreihen; Meta gibt Instagram-Demografie erst ab 100 Followern; YouTube-Analytics laufen 2 bis 3 Tage nach; LinkedIn liefert Zielgruppen-Schlüssel als URNs.

## Claude verbinden (MCP)

MCP-Endpunkt: `{APP_URL}/api/mcp` (Streamable HTTP, MCP-Spec 2026-07-28 mit Fallback). Auth per `Authorization: Bearer <API-Key>`. Keys: `MCP_API_KEY` aus der `.env` oder in der App unter Einstellungen erzeugen.

```bash
# Claude Code
claude mcp add --transport http socialhub https://deine-app.example/api/mcp --header "Authorization: Bearer sh_..."

# Claude Desktop / claude.ai (wenn keine Header-Option vorhanden): mcp-remote als Brücke
npx -y mcp-remote https://deine-app.example/api/mcp --header "Authorization: Bearer sh_..."
```

Tools: `list_brands`, `create_brand`, `get_network_capabilities`, `list_connections`, `get_connect_url`, `sync_connection`, `get_overview`, `get_timeseries`, `get_posts`, `get_audience`, `get_report_data`, `save_report`, `list_reports`, `get_report`, `list_media`, `import_media_from_url`, `get_publish_options`, `publish_video`, `get_publish_status`, `list_scheduled_posts`, `cancel_scheduled_post`. Prompt: `weekly_report`.

Typischer autonomer Ablauf, den Claude selbst wählt:

1. `sync_connection` (brand=…, wait=true) → frische Daten.
2. `get_report_data` → Kennzahlen, Zeitreihen, Top-Posts, Zielgruppen als JSON und Markdown-Tabellen.
3. Bericht schreiben, `save_report` → Link in der App.
4. Parallel: `import_media_from_url` oder `list_media` → `publish_video` mit `targets` und Optionen → `get_publish_status`.

Nur das OAuth-Verbinden eines Kontos braucht einen Menschen im Browser (`get_connect_url` liefert den Link).

## Betrieb (Produktion)

- `DATABASE_URL` auf Postgres setzen (Migrationen laufen beim Start automatisch aus `./drizzle`).
- Entweder `RUN_WORKER_IN_APP=true` lassen (ein Prozess) oder `RUN_WORKER_IN_APP=false` und `npm run worker` als eigenen Prozess starten.
- Medien: `MEDIA_STORAGE=s3` mit Bucket, Region, Endpoint und `S3_PUBLIC_BASE_URL` (Cloudflare R2, MinIO, AWS S3).
- Reverse Proxy mit HTTPS vor `npm run start`; `APP_URL` auf die öffentliche Domain.
- Uploads: Standard-Limit des Reverse-Proxy (z. B. nginx `client_max_body_size`) hochsetzen, Videos sind groß.

## Scripts

| Befehl | Zweck |
|---|---|
| `npm run dev` | Entwicklung |
| `npm run build` / `npm start` | Produktion |
| `npm run typecheck` | TypeScript |
| `npm test` | Unit-Tests (Vitest, eigene PGlite-DB pro Lauf) |
| `npm run db:generate` | Migrationen nach Schema-Änderung erzeugen |
| `npm run worker` | separater Worker (nur mit Postgres) |
| `npm run setup` | `.env` mit Secrets anlegen |

## Architektur

```
src/
  app/                    Seiten (Server Components), Server Actions, API-Routen
    api/mcp               MCP-Server (mcp-handler, Bearer-Auth)
    api/oauth/[provider]  OAuth-Start und -Callback
    api/media             Upload und öffentliche Auslieferung (Range-Requests)
    oauth/select, done    Popup-Seiten: Kontoauswahl, Rückmeldung per postMessage
  lib/
    connectors/           ein Modul je Netzwerk: OAuth, syncAccount, syncPosts, syncAudience, publishVideo
    services/             Verbindungen (Token-Refresh), Sync-Upserts, Analytics-Abfragen, Publishing, Reports, Medien
    jobs/                 DB-Queue, Worker-Schleife, Handler (sync.*, token.refresh, publish.*, schedule.tick)
    db/                   Drizzle-Schema und Verbindung (PGlite oder Postgres)
    mcp/                  Tool-Definitionen
    auth/                 Session-Cookie (jose) und API-Keys (SHA-256)
    storage/              lokal oder S3
```

Datenmodell: `brands` → `connections` (Tokens verschlüsselt) → `metric_daily` (Konto × Metrik × Tag), `posts` + `post_metrics` (Tages-Snapshots), `audience` (Dimension × Schlüssel), `media`, `scheduled_posts` + `publish_targets`, `reports`, `jobs`, `api_keys`.

Sync-Rhythmus: beim Verbinden 90 Tage Backfill, danach alle `SYNC_INTERVAL_MINUTES` (Standard 60) die letzten 7 Tage Kontometriken und 30 Tage Beiträge. Tokens werden 2 h vor Ablauf erneuert; schlägt das fehl, zeigt die App „neu verbinden“.

## Grenzen und offene Punkte

- OAuth-Flows wurden gegen die offiziellen API-Dokumentationen gebaut und mit gemockten Antworten getestet, aber noch nicht gegen echte Plattform-Apps durchgespielt. Beim ersten echten Verbinden können Details abweichen (Scope-Namen, API-Versionen); Fehlermeldungen werden in der UI angezeigt.
- Instagram-Login ohne Facebook-Seite („Instagram API with Instagram Login“) ist nicht implementiert; verwendet wird der Weg über die Facebook-Seite, der mehr Daten liefert.
- Inbox (Kommentare/DMs), Wettbewerber und Hashtag-Tracking sind nicht enthalten.
- Kein Mehrbenutzer-Login; die Oberfläche hat ein gemeinsames Passwort, die MCP-Schnittstelle API-Keys.
