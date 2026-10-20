import type { Connector, Network, OAuthProvider } from "./types";
import { facebookConnector, instagramConnector } from "./meta";
import { youtubeConnector } from "./youtube";
import { tiktokConnector } from "./tiktok";
import { linkedinConnector } from "./linkedin";
import { xConnector } from "./x";

const all: Connector[] = [instagramConnector, facebookConnector, youtubeConnector, tiktokConnector, linkedinConnector, xConnector];

export function allConnectors(): Connector[] {
  return all;
}

export function connectorFor(network: Network): Connector {
  const c = all.find((x) => x.network === network);
  if (!c) throw new Error(`Unbekanntes Netzwerk: ${network}`);
  return c;
}

export function connectorsForProvider(provider: OAuthProvider): Connector[] {
  return all.filter((c) => c.provider === provider);
}

export function providerFor(network: Network): OAuthProvider {
  return connectorFor(network).provider;
}

export const PROVIDERS: OAuthProvider[] = ["meta", "google", "tiktok", "linkedin", "x"];

export function isProvider(v: string): v is OAuthProvider {
  return (PROVIDERS as string[]).includes(v);
}

export const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  meta: "Facebook & Instagram",
  google: "YouTube",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
};
