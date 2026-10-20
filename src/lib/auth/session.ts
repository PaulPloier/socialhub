import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../env";
import { safeEqual } from "../crypto";

const COOKIE = "socialhub_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

function secret(): Uint8Array {
  const s = env().AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET fehlt (siehe .env.example, `npm run setup` erzeugt einen Wert).");
  return new TextEncoder().encode(s);
}

export function checkPassword(candidate: string): boolean {
  const pw = env().AUTH_PASSWORD;
  if (!pw) return false;
  return safeEqual(candidate, pw);
}

export async function createSession(): Promise<void> {
  const token = await new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().APP_URL.startsWith("https://"),
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, secret());
    return true;
  } catch {
    return false;
  }
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(COOKIE)?.value);
}

export const SESSION_COOKIE = COOKIE;
