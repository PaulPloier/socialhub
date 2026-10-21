# SocialHub einrichten: Schritt für Schritt

Reihenfolge einhalten. Jeder Block endet mit einem Test, damit du weißt, dass der Schritt sitzt.

---

## Teil A: Server (einmalig, ca. 30 Minuten)

### A1. Domain und HTTPS

1. Lege eine Subdomain an, z. B. `social.telldigital.at`, und zeige sie per A-Record auf deinen Server.
2. Stelle sicher, dass die App über **https://** erreichbar ist. Ohne HTTPS akzeptiert keine Plattform die Redirect-URIs.

### A2. Datenbank

1. Lege ein Postgres an (beim Hoster als Add-on, auf einem VPS mit `apt install postgresql`).
2. Erzeuge Datenbank und Benutzer:
   ```sql
   CREATE USER socialhub WITH PASSWORD 'langes-passwort';
   CREATE DATABASE socialhub OWNER socialhub;
   ```
3. Notiere die URL: `postgres://socialhub:langes-passwort@HOST:5432/socialhub`

### A3. Umgebungsvariablen setzen

Im Hosting-Panel (oder in einer `.env` auf dem Server) diese Werte eintragen:

```
APP_URL=https://social.telldigital.at
DATABASE_URL=postgres://socialhub:langes-passwort@HOST:5432/socialhub
AUTH_PASSWORD=<dein Login-Passwort>
AUTH_SECRET=<Ausgabe von: openssl rand -base64 32>
ENCRYPTION_KEY=<Ausgabe von: openssl rand -base64 32>
MCP_API_KEY=sh_<Ausgabe von: openssl rand -base64 24>
RUN_WORKER_IN_APP=true
MEDIA_STORAGE=local
DATA_DIR=/var/lib/socialhub
```

`DATA_DIR` muss ein Ordner sein, der Deploys überlebt (persistente Platte oder Volume). Alternativ `MEDIA_STORAGE=s3` mit den `S3_*`-Variablen aus `.env.example` (Cloudflare R2 ist kostenlos bis 10 GB).

### A4. Upload-Limit

Reverse-Proxy auf mindestens 500 MB stellen:

- nginx: `client_max_body_size 500m;`
- Caddy: `request_body { max_size 500MB }`
- Railway/Render: kein Limit nötig

### A5. Deploy und Test

1. Build `npm run build`, Start `npm start` (Port 3000) oder beim Hoster auf „Deploy" klicken.
2. Öffne `https://social.telldigital.at/api/health`. Erwartet: `{"ok":true,"db":"postgres"}`. Steht dort `pglite`, fehlt `DATABASE_URL`.
3. Öffne `https://social.telldigital.at`, melde dich mit `AUTH_PASSWORD` an, lege die Brand „f0under.daily" an.
4. Öffne **Einstellungen**: Dort stehen die exakten Redirect-URIs für Teil B.

---

## Teil B: Plattform-Apps anlegen

Du brauchst für jede Plattform eine „App" beim Entwicklerportal. Das ist nur eine Registrierung, kein Code.

### B1. Meta (Facebook + Instagram), ca. 30 Minuten

Voraussetzung: Das Instagram-Konto ist ein Business- oder Creator-Konto und mit einer Facebook-Seite verknüpft (Instagram-App → Einstellungen → Konto → Mit Facebook-Seite verbinden).

1. Gehe auf **developers.facebook.com**, melde dich mit dem Facebook-Konto an, das Admin der Seite ist.
2. **Meine Apps → App erstellen**. Anwendungsfall: „Andere", Typ: **Business**. Name: SocialHub. Falls gefragt, dein Business-Portfolio auswählen.
3. Im App-Dashboard unter **Produkte hinzufügen**: **Facebook Login for Business** hinzufügen, dann **Instagram** hinzufügen.
4. **Facebook Login for Business → Einstellungen**: Bei „Gültige OAuth Redirect URIs" eintragen:
   ```
   https://social.telldigital.at/api/oauth/meta/callback
   ```
   Speichern.
5. **App-Einstellungen → Allgemein**: `App-ID` und `App-Geheimcode` (auf „Anzeigen" klicken) kopieren. Außerdem eintragen: App-Domain `social.telldigital.at`, Datenschutzerklärungs-URL (z. B. `https://telldigital.at/datenschutz`), URL zum Löschen von Nutzerdaten (dieselbe Seite genügt vorerst).
6. **App-Rollen → Rollen**: Dich selbst als Administrator haben (bist du bereits). Für weitere eigene Konten: deren Facebook-Nutzer als „Tester" hinzufügen.
7. Umgebungsvariablen setzen und App neu starten:
   ```
   META_APP_ID=...
   META_APP_SECRET=...
   ```
8. **Test:** In SocialHub auf „Facebook & Instagram verbinden". Im Popup bei Facebook anmelden, die Seite auswählen, alle Berechtigungen bestätigen. Danach erscheinen Facebook-Seite und Instagram-Konto als Karten. Nach 1 bis 5 Minuten stehen die ersten Zahlen.

Typische Fehler: „Keine Facebook-Seite gefunden" → Instagram ist nicht mit der Seite verknüpft oder du hast nicht Vollzugriff auf die Seite. „Invalid redirect_uri" → URI in Schritt 4 stimmt nicht exakt (https, keine Slash-Endung).

Im Entwicklungsmodus funktioniert das für alle Konten, bei denen du Admin oder Tester bist. Für fremde Kundenkonten brauchst du später „App Review" (Punkt D).

### B2. Google (YouTube), ca. 20 Minuten

1. Gehe auf **console.cloud.google.com**, lege ein Projekt „SocialHub" an.
2. **APIs & Dienste → Bibliothek**: **YouTube Data API v3** aktivieren, dann **YouTube Analytics API** aktivieren.
3. **APIs & Dienste → OAuth-Zustimmungsbildschirm**: Typ „Extern", App-Name SocialHub, Support-E-Mail, Domain `telldigital.at`. Unter „Testnutzer" die Google-Konten eintragen, die YouTube-Kanäle verbinden sollen (max. 100, solange die App im Testmodus ist).
4. **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**. Typ: **Webanwendung**. Autorisierte Weiterleitungs-URI:
   ```
   https://social.telldigital.at/api/oauth/google/callback
   ```
5. Client-ID und Client-Secret kopieren:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
6. **Test:** „YouTube verbinden" → Google-Login → Zugriff auf YouTube bestätigen (alle vier Häkchen). Der Kanal erscheint als Karte. Hinweis „Diese App wurde nicht von Google überprüft" ist im Testmodus normal, auf „Weiter" klicken.

### B3. TikTok, ca. 20 Minuten plus Prüfung durch TikTok

1. Gehe auf **developers.tiktok.com**, registriere dich als Entwickler.
2. **Manage apps → Connect an app**. Name SocialHub, Kategorie „Content Creation", Plattform **Web**, Website-URL `https://social.telldigital.at`.
3. **Add products**: **Login Kit**, **Display API** (bei manchen Konten „Scopes" genannt) und **Content Posting API** hinzufügen. Bei Content Posting API „Direct Post" auswählen.
4. **Login Kit → Redirect URI**:
   ```
   https://social.telldigital.at/api/oauth/tiktok/callback
   ```
5. Unter **Scopes** alle sechs freischalten: `user.info.basic, user.info.profile, user.info.stats, video.list, video.publish, video.upload`.
6. **Domain-Verifizierung** für `social.telldigital.at` durchführen (TikTok gibt eine Datei oder einen DNS-Eintrag vor).
7. App **zur Prüfung einreichen** („Submit for review"). Bis zur Freigabe funktioniert der Login nur für dein eigenes TikTok-Konto (als „Sandbox"-Zielkonto eintragen) und Veröffentlichungen sind privat.
8. `Client key` und `Client secret` kopieren:
   ```
   TIKTOK_CLIENT_KEY=...
   TIKTOK_CLIENT_SECRET=...
   ```
9. **Test:** „TikTok verbinden" → QR-Code mit der TikTok-App scannen oder einloggen → bestätigen.

### B4. LinkedIn, ca. 15 Minuten plus Freigabe durch LinkedIn

Voraussetzung: Du bist Admin einer LinkedIn-Unternehmensseite (Personenprofile unterstützt die API nicht).

1. Gehe auf **linkedin.com/developers → Create app**. Name SocialHub, **LinkedIn Page**: deine Unternehmensseite auswählen, Logo hochladen.
2. **Settings → Verify**: Die Seite muss die App bestätigen (Link an den Seiten-Admin, das bist du).
3. **Products**: **Community Management API** anfordern („Request access"). Formular ausfüllen, Zweck: Analytics und Veröffentlichung für eigene Unternehmensseiten. Freigabe dauert einige Tage.
4. **Auth → OAuth 2.0 settings → Authorized redirect URLs**:
   ```
   https://social.telldigital.at/api/oauth/linkedin/callback
   ```
5. Client ID und Client Secret kopieren:
   ```
   LINKEDIN_CLIENT_ID=...
   LINKEDIN_CLIENT_SECRET=...
   ```
6. **Test** (erst nach Freigabe des Produkts): „LinkedIn verbinden" → Login → Seite erscheint.

### B5. X (Twitter), ca. 15 Minuten, kostenpflichtig

1. Gehe auf **developer.x.com**, wähle ein Paket. Für Posting und Metriken ist mindestens **Basic** nötig (kostenpflichtig, Preis prüfen). Free reicht nicht.
2. **Projects & Apps → Create project → Create app**. Name SocialHub.
3. **User authentication settings → Set up**: App permissions **Read and write**, Type of App **Web App, Automated App or Bot** (Confidential client), Callback URI:
   ```
   https://social.telldigital.at/api/oauth/x/callback
   ```
   Website URL `https://social.telldigital.at`.
4. **Keys and tokens → OAuth 2.0 Client ID and Client Secret** kopieren:
   ```
   X_CLIENT_ID=...
   X_CLIENT_SECRET=...
   ```
5. **Test:** „X (Twitter) verbinden" → Autorisieren.

---

## Teil C: Claude anbinden (5 Minuten)

### Claude Code

```bash
claude mcp add --transport http socialhub https://social.telldigital.at/api/mcp --header "Authorization: Bearer <MCP_API_KEY>"
```

### Claude Desktop

In `claude_desktop_config.json` (Einstellungen → Entwickler → Konfiguration bearbeiten):

```json
{
  "mcpServers": {
    "socialhub": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://social.telldigital.at/api/mcp", "--header", "Authorization: Bearer <MCP_API_KEY>"]
    }
  }
}
```

### claude.ai (Web)

Einstellungen → Connectors → Custom Connector → URL `https://social.telldigital.at/api/mcp?key=<MCP_API_KEY>` (Fallback für Clients ohne Header-Feld; nur über HTTPS verwenden).

### Erster Testauftrag

> „Liste meine Brands und Konten auf, synchronisiere f0under.daily und zeig mir die Übersicht der letzten 7 Tage."

Danach der volle Ablauf:

> „Hol die neuesten Analytics für f0under.daily, schreib mir einen Wochenbericht und speichere ihn. Lade in der Zwischenzeit dieses Video als Reel auf Instagram hoch: https://…/clip.mp4, mit passender Beschreibung und Hashtags."

---

## Teil D: Freigaben für Kundenkonten (nur wenn nötig)

Solange nur eigene Konten verbunden werden, bei denen du Admin, Tester oder Testnutzer bist, ist Teil D unnötig.

| Plattform | Verfahren | Dauer | Benötigt |
|---|---|---|---|
| Meta | App Review + Business-Verifizierung | 1 bis 4 Wochen | Screencast des Verbindungsflows, Datenschutz-URL, Firmendokument |
| Google | OAuth-Verifizierung (sensitive scopes) | 1 bis 6 Wochen | Datenschutz-URL, Demo-Video, Domain-Nachweis |
| TikTok | App-Audit | 1 bis 2 Wochen | Demo-Video jedes Scopes |
| LinkedIn | Community Management API | wenige Tage | Begründung im Formular |
| X | keines, nur Bezahlpaket | sofort | Basic-Tier |

---

## Checkliste

- [ ] HTTPS-Domain zeigt auf die App
- [ ] `/api/health` meldet `postgres`
- [ ] Login funktioniert, Brand angelegt
- [ ] Meta: App-ID/Secret gesetzt, Facebook + Instagram verbunden, erste Zahlen sichtbar
- [ ] Google: Client gesetzt, YouTube verbunden
- [ ] TikTok: Client gesetzt, zur Prüfung eingereicht, eigenes Konto verbunden
- [ ] LinkedIn: Produktzugang beantragt
- [ ] X: Bezahlpaket gebucht, verbunden (optional)
- [ ] Claude per MCP verbunden, Testauftrag erfolgreich
- [ ] Ein Test-Video über die App veröffentlicht (z. B. YouTube „nicht gelistet")
