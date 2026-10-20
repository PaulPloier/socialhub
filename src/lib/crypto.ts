import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const ALGO = "aes-256-gcm";

function keyBytes(): Buffer {
  const raw = env().ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY fehlt. Erzeuge einen Schlüssel mit `npm run setup` oder `openssl rand -base64 32`.");
  }
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  const hex = Buffer.from(raw, "hex");
  if (hex.length === 32) return hex;
  // Fallback: beliebigen String deterministisch auf 32 Byte bringen.
  return createHash("sha256").update(raw).digest();
}

/** Verschlüsselt einen String; Ausgabeformat: base64(iv).base64(tag).base64(ciphertext) */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Ungültiges verschlüsseltes Token-Format");
  const decipher = createDecipheriv(ALGO, keyBytes(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// PKCE (RFC 7636)
export function pkceVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** API-Keys: Klartext nur einmal anzeigen, DB speichert den SHA-256-Hash. */
export function newApiKey(): { plain: string; hash: string; prefix: string } {
  const plain = `sh_${randomBytes(24).toString("base64url")}`;
  return { plain, hash: sha256(plain), prefix: plain.slice(0, 10) };
}
