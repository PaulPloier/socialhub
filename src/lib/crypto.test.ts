import { describe, expect, it } from "vitest";
import { decrypt, encrypt, newApiKey, pkceChallenge, pkceVerifier, sha256 } from "./crypto";

describe("crypto", () => {
  it("verschlüsselt und entschlüsselt Tokens", () => {
    const token = "EAAB...sehr-geheimes-token-" + "x".repeat(200);
    const enc = encrypt(token);
    expect(enc).not.toContain(token);
    expect(enc.split(".")).toHaveLength(3);
    expect(decrypt(enc)).toBe(token);
    expect(encrypt(token)).not.toBe(enc); // zufälliger IV
  });

  it("erkennt manipulierte Daten", () => {
    const enc = encrypt("abc");
    const [iv, tag, data] = enc.split(".");
    const tampered = `${iv}.${tag}.${data.slice(0, -2)}AA`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it("erzeugt PKCE-Verifier und S256-Challenge", () => {
    const v = pkceVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(pkceChallenge(v)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceChallenge(v)).toBe(pkceChallenge(v));
  });

  it("erzeugt API-Keys mit Hash", () => {
    const k = newApiKey();
    expect(k.plain.startsWith("sh_")).toBe(true);
    expect(k.hash).toBe(sha256(k.plain));
    expect(k.prefix).toBe(k.plain.slice(0, 10));
  });
});
