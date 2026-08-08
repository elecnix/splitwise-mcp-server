/**
 * Splitwise MCP Server — Cloudflare Worker (OAuth 2.1 protected)
 *
 * A PUBLIC MCP server that authenticates EACH user against their OWN
 * Splitwise account via OAuth 2.0, so no caller can ever act on another
 * user's account (in particular, not on the owner's account).
 *
 * Security model:
 *   - The worker holds only the SPLITWISE_CLIENT_ID / SPLITWISE_CLIENT_SECRET
 *     (application credentials, tied to no user account).
 *   - A user connecting visits /authorize, is redirected to Splitwise's
 *     OAuth consent screen, and authorizes THEIR OWN account.
 *   - The worker exchanges the code for an access token limited to that
 *     user, stores it encrypted in the OAuth grant (workers-oauth-provider),
 *     and every Splitwise API call is made with THAT user's token.
 *   - /mcp is gated by the OAuth provider: no valid token, no MCP access.
 *
 * Built on Cloudflare's official @cloudflare/workers-oauth-provider.
 */

import {
  OAuthProvider,
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { handleMcpRequest } from "./mcp";

const SPLITWISE_AUTHORIZE = "https://secure.splitwise.com/oauth/authorize";
const SPLITWISE_TOKEN = "https://secure.splitwise.com/oauth/token";
const SPLITWISE_API = "https://secure.splitwise.com/api/v3.0";

export interface Env {
  OAUTH_KV: KVNamespace;
  FLOW_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  SPLITWISE_CLIENT_ID: string;
  SPLITWISE_CLIENT_SECRET: string;
}

/** Authenticated application state attached to /mcp requests (encrypted). */
interface AuthProps {
  splitwiseUserId: string;
  splitwiseName: string;
  splitwiseAccessToken: string;
}

/**
 * Protected MCP handler. Runs only after the OAuth provider validated a
 * bearer token, at which point this.ctx.props holds the authenticated
 * user's Splitwise access token (their own account).
 */
class McpApiHandler extends WorkerEntrypoint<Env, AuthProps> {
  override async fetch(request: Request): Promise<Response> {
    try {
      return await handleMcpRequest(request, this.ctx.props.splitwiseAccessToken);
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/callback") {
      return handleCallback(request, env);
    }

    return html(
      200,
      "<h1>Splitwise MCP</h1><p>Ce serveur MCP est protégé par OAuth : chaque utilisateur " +
        "se connecte avec son propre compte Splitwise.</p>" +
        "<p>Connectez le point d'accès <code>/mcp</code> depuis un client MCP " +
        "(Claude Desktop, mcp-remote, ...) pour être redirigé vers Splitwise.</p>"
    );
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",

  // Allow MCP clients to register dynamically (Claude Desktop, mcp-remote,
  // etc.). CIMD gives new clients an even lighter path.
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,

  resourceMetadata: {
    resource: "https://splitwise.mcp.marchildon.net/mcp",
    authorization_servers: ["https://splitwise.mcp.marchildon.net"],
    scopes_supported: [],
    resource_name: "Splitwise MCP server (per-user accounts)",
  },
});

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) {
      return html(400, `<p>Requête invalide : ${escapeHtml(error.description)}</p>`);
    }
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }

  // Persist the pending auth request across the Splitwise hop. The id is
  // passed to Splitwise as `state` so /callback can recover it.
  const sessionId = crypto.randomUUID();
  await env.FLOW_KV.put(`flow:${sessionId}`, JSON.stringify(oauthRequest), {
    expirationTtl: 600,
  });

  const sw = new URL(SPLITWISE_AUTHORIZE);
  sw.searchParams.set("client_id", env.SPLITWISE_CLIENT_ID);
  sw.searchParams.set("redirect_uri", `${new URL(request.url).origin}/callback`);
  sw.searchParams.set("response_type", "code");
  sw.searchParams.set("state", sessionId);
  return Response.redirect(sw.toString(), 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  if (!sessionId) return html(400, "<p>Session OAuth manquante.</p>");
  if (oauthError) {
    if (sessionId) await env.FLOW_KV.delete(`flow:${sessionId}`);
    return html(
      400,
      `<p>Autorisation refusée : ${escapeHtml(url.searchParams.get("error_description") || oauthError)}</p>`
    );
  }

  const pending = await env.FLOW_KV.get(`flow:${sessionId}`);
  await env.FLOW_KV.delete(`flow:${sessionId}`);
  if (!pending || !code) return html(400, "<p>Code ou session OAuth invalide.</p>");

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = JSON.parse(pending);
  } catch {
    return html(400, "<p>Session OAuth invalide.</p>");
  }

  const redirectUri = `${url.origin}/callback`;

  // Exchange the authorization code for the USER's Splitwise access token.
  const tokenRes = await fetch(SPLITWISE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.SPLITWISE_CLIENT_ID,
      client_secret: env.SPLITWISE_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  const tokenBody: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenBody?.access_token) {
    return html(
      400,
      `<p>Échec de la connexion à Splitwise : ${escapeHtml(tokenBody?.error_description || tokenBody?.error || `HTTP ${tokenRes.status}`)}</p>`
    );
  }

  // Identify the user whose account was authorized.
  const meRes = await fetch(`${SPLITWISE_API}/get_current_user`, {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  const meBody: any = await meRes.json().catch(() => ({}));
  const user = meBody?.user || {};
  const userId = String(user?.id ?? "unknown");
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim() || userId;

  // Complete the MCP-layer OAuth flow and redirect the client back.
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId,
    metadata: { name },
    scope: oauthRequest.scope,
    props: {
      splitwiseUserId: userId,
      splitwiseName: name,
      splitwiseAccessToken: tokenBody.access_token,
    } satisfies AuthProps,
  });

  return Response.redirect(redirectTo, 302);
}

function html(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><body style="font-family:sans-serif;max-width:40em;margin:2em auto">${body}</body></html>`,
    { status, headers: { "content-type": "text/html;charset=utf-8" } }
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}