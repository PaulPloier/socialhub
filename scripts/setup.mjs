#!/usr/bin/env node
/**
 * Erzeugt eine .env mit sicheren Zufallswerten, falls noch keine existiert.
 * Plattform-Zugangsdaten (Meta, Google, TikTok, LinkedIn, X) trägst du danach ein.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const target = ".env";
if (existsSync(target)) {
  console.log(".env existiert bereits, nichts geändert.");
  process.exit(0);
}
const example = readFileSync(".env.example", "utf8");
const out = example
  .replace(/^AUTH_PASSWORD=.*$/m, `AUTH_PASSWORD=${randomBytes(9).toString("base64url")}`)
  .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${randomBytes(32).toString("base64url")}`)
  .replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`)
  .replace(/^MCP_API_KEY=.*$/m, `MCP_API_KEY=sh_${randomBytes(24).toString("base64url")}`);
writeFileSync(target, out);
const pw = /^AUTH_PASSWORD=(.*)$/m.exec(out)?.[1];
const key = /^MCP_API_KEY=(.*)$/m.exec(out)?.[1];
console.log(".env angelegt.");
console.log(`Login-Passwort (AUTH_PASSWORD): ${pw}`);
console.log(`MCP-API-Key (MCP_API_KEY):      ${key}`);
console.log("Jetzt die Plattform-Zugangsdaten in .env eintragen und `npm run dev` starten.");
