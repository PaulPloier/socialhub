/**
 * Kleiner HTTP-Client für Plattform-APIs: JSON-Parsing, Fehlerobjekt mit Status
 * und Body, Retry mit exponentiellem Backoff bei 429/5xx und Netzwerkfehlern.
 */

export class ConnectorHttpError extends Error {
  status: number;
  body: unknown;
  url: string;
  constructor(message: string, status: number, body: unknown, url: string) {
    super(message);
    this.name = "ConnectorHttpError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
  /** Token abgelaufen / widerrufen → Nutzer muss neu verbinden. */
  get isAuthError(): boolean {
    if (this.status === 401) return true;
    if (this.status === 403 && /token|permission|scope/i.test(JSON.stringify(this.body ?? ""))) return true;
    if (this.status === 400 && /OAuthException|invalid_token|expired/i.test(JSON.stringify(this.body ?? ""))) return true;
    return false;
  }
}

export interface FetchJsonOptions extends RequestInit {
  retries?: number;
  timeoutMs?: number;
  /** Erwartet keinen JSON-Body (z. B. 204 oder binär). */
  raw?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { retries = 3, timeoutMs = 60_000, raw = false, ...init } = options;
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        if (raw) return res as unknown as T;
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }
      const bodyText = await res.text();
      let body: unknown = bodyText;
      try {
        body = JSON.parse(bodyText);
      } catch {
        /* Text behalten */
      }
      const err = new ConnectorHttpError(`${init.method ?? "GET"} ${url} → ${res.status}: ${summarize(body)}`, res.status, body, url);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries) throw err;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      lastError = err;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ConnectorHttpError) throw e;
      lastError = e;
      if (attempt === retries) break;
      await sleep(backoff(attempt));
    }
    attempt++;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
}

export function summarize(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body.slice(0, 300);
  const b = body as Record<string, unknown>;
  const err = (b.error as Record<string, unknown> | undefined) ?? b;
  const msg = (err?.message ?? err?.error_description ?? err?.error ?? b.message) as unknown;
  return typeof msg === "string" ? msg.slice(0, 300) : JSON.stringify(body).slice(0, 300);
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

export function formBody(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, v);
  return sp.toString();
}

/** YYYY-MM-DD in UTC */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysBetween(since: Date, until: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  const end = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()));
  while (d <= end) {
    out.push(isoDate(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function unix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}
