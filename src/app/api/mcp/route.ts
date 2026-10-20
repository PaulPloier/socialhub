import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerTools } from "@/lib/mcp/server";
import { bearerFromRequest, verifyApiKey } from "@/lib/auth/api-key";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const handler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  {
    serverInfo: { name: "socialhub", version: "0.1.0" },
    instructions:
      "SocialHub verwaltet Social-Media-Konten (Facebook, Instagram, YouTube, TikTok, LinkedIn, X): Analytics abrufen, Reports speichern, Videos veröffentlichen. Starte mit list_brands und get_network_capabilities. Für neue Daten zuerst sync_connection aufrufen.",
  },
);

/**
 * Auth: Bearer-Token im Authorization-Header (empfohlen). Fallback für Clients
 * ohne Header-Konfiguration: ?key=... in der URL (nur über HTTPS verwenden).
 */
const authed = withMcpAuth(
  handler,
  async (req, bearer) => {
    const token = bearer ?? bearerFromRequest(req) ?? new URL(req.url).searchParams.get("key");
    const principal = await verifyApiKey(token);
    if (!principal) return undefined;
    return { token: token!, clientId: principal.keyId, scopes: ["socialhub"], extra: { name: principal.name } };
  },
  { required: true },
);

export { authed as GET, authed as POST, authed as DELETE };
