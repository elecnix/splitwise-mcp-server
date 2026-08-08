/**
 * Splitwise MCP Server — Cloudflare Worker
 *
 * Exposes the Splitwise API as an MCP server over Streamable HTTP,
 * so any MCP client can call it remotely (public, free, no auth on the
 * MCP layer). The Splitwise personal API key lives in a Worker secret
 * (SPLITWISE_API_KEY) and is never exposed to clients.
 *
 * Tools (8, ported from the Python FastMCP server):
 *   splitwise_test_auth, splitwise_get_groups, splitwise_get_friends,
 *   splitwise_get_expenses, splitwise_create_expense,
 *   splitwise_get_group_balances, splitwise_get_oauth_url,
 *   splitwise_exchange_oauth_code
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { SplitwiseClient } from "./splitwise";

export interface Env {
  SPLITWISE_API_KEY: string;
  SPLITWISE_CLIENT_ID?: string;
  SPLITWISE_CLIENT_SECRET?: string;
}

function getClient(env: Env): SplitwiseClient {
  if (!env.SPLITWISE_API_KEY) {
    throw new Error("SPLITWISE_API_KEY secret is not configured on this worker.");
  }
  return new SplitwiseClient(env.SPLITWISE_API_KEY);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const server = new McpServer({
      name: "Splitwise MCP Server",
      version: "1.0.0",
    });

    registerTools(server, env);

    // Stateless mode: each request is self-contained (cleanest fit for Workers).
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

function registerTools(server: McpServer, env: Env) {
  const client = () => getClient(env);

  server.tool("splitwise_test_auth", "Test the Splitwise API connection and display auth info.", {}, async () => {
    try {
      const u = await client().getCurrentUser();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: "✅ Authentification réussie",
          user: {
            id: u.id, first_name: u.first_name, last_name: u.last_name,
            email: u.email, default_currency: (u as any).default_currency,
            locale: (u as any).locale,
          },
        }, null, 2) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "❌ Erreur", error: e.message }, null, 2) }] };
    }
  });

  server.tool("splitwise_get_groups", "List all Splitwise groups with their members and balances.", {}, async () => {
    try {
      const groups = await client().getGroups();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ groups }, null, 2) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "❌ Erreur", error: e.message }, null, 2) }] };
    }
  });

  server.tool("splitwise_get_friends", "List all Splitwise friends with their balances.", {}, async () => {
    try {
      const friends = await client().getFriends();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ friends }, null, 2) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "❌ Erreur", error: e.message }, null, 2) }] };
    }
  });

  server.tool(
    "splitwise_get_expenses",
    "Retrieve expenses with optional filters.",
    {
      group_id: z.number().int().optional().describe("Filter by group ID"),
      friend_id: z.number().int().optional().describe("Filter by friend ID"),
      limit: z.number().int().default(50).describe("Max results"),
      offset: z.number().int().default(0).describe("Pagination offset"),
    },
    async ({ group_id, friend_id, limit, offset }) => {
      try {
        const expenses = await client().getExpenses({ group_id, friend_id, limit, offset });
        return { content: [{ type: "text" as const, text: JSON.stringify({ expenses }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "❌ Erreur", error: e.message }, null, 2) }] };
      }
    }
  );

  server.tool(
    "splitwise_create_expense",
    "Create a new Splitwise expense.",
    {
      description: z.string().describe("Description of the expense"),
      cost: z.number().describe("Total cost of the expense"),
      currency_code: z.string().default("USD").describe("Currency code (USD, CAD, EUR...)"),
      group_id: z.number().int().optional().describe("Group ID"),
      friend_ids: z.array(z.number().int()).optional().describe("Friend user IDs to include"),
      split_equally: z.boolean().default(true).describe("Split equally among participants"),
      payment: z.boolean().default(false).describe("Mark as a payment"),
      details: z.string().optional(),
      date: z.string().optional().describe("Date YYYY-MM-DD"),
    },
    async (args) => {
      try {
        const c = client();
        const current = await c.getCurrentUser();
        const cost = String(args.cost);

        // Build participants. Default: payer = current user, split among users.
        const users: Record<string, any>[] = [];
        const participantIds = args.friend_ids && args.friend_ids.length
          ? args.friend_ids
          : [];

        if (!args.group_id && participantIds.length === 0) {
          throw new Error("Provide either a group_id or friend_ids to split the expense with.");
        }

        if (participantIds.length > 0) {
          const share = args.split_equally
            ? (Number(cost) / (participantIds.length + 1)).toFixed(2)
            : "0.00";
          users.push({ user_id: current.id, paid_share: cost, owed_share: args.split_equally ? share : "0.00" });
          for (const fid of participantIds) {
            users.push({ user_id: fid, paid_share: "0.00", owed_share: args.split_equally ? share : "0.00" });
          }
        } else {
          // Group expense: current user pays full cost, owes 0; group splits the rest.
          users.push({ user_id: current.id, paid_share: cost, owed_share: "0.00" });
        }

        const payload: Record<string, any> = {
          description: args.description,
          cost,
          currency_code: args.currency_code,
          payment: args.payment,
          split_equally: args.split_equally ? "true" : "false",
          users,
        };
        if (args.group_id) payload.group_id = args.group_id;
        if (args.details) payload.details = args.details;
        if (args.date) payload.date = args.date;

        const created = await c.createExpense(payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "✅ Dépense créée avec succès",
            expense: {
              id: created?.id ?? null,
              description: created?.description ?? args.description,
              cost: created?.cost ?? args.cost,
              currency_code: args.currency_code,
              group_id: created?.group_id ?? args.group_id ?? null,
              date: created?.date ?? args.date ?? null,
            },
          }, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "❌ Erreur", error: e.message }, null, 2) }] };
      }
    }
  );

  server.tool("splitwise_get_group_balances", "Get balances for all members in a group.", {
    group_id: z.number().int().describe("The Splitwise group ID"),
  }, async ({ group_id }) => {
    try {
      const group = await client().getGroup(group_id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ group }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "❌ Erreur", error: e.message }, null, 2) }] };
    }
  });

  server.tool("splitwise_get_oauth_url", "Generate an OAuth2 authorization URL (requires SPLITWISE_CLIENT_ID).", {}, async () => {
    if (!env.SPLITWISE_CLIENT_ID) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "❌ Erreur", error: "SPLITWISE_CLIENT_ID secret not set" }, null, 2) }] };
    }
    const url = `https://secure.splitwise.com/oauth/authorize?response_type=code&client_id=${env.SPLITWISE_CLIENT_ID}&redirect_uri=https://splitwise.mcp.marchildon.net/callback`;
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: "✅ URL d'autorisation générée", url }, null, 2) }] };
  });

  server.tool("splitwise_exchange_oauth_code", "Exchange an OAuth2 authorization code for an access token.", {
    code: z.string().describe("The authorization code from the OAuth callback"),
  }, async ({ code }) => {
    const cid = env.SPLITWISE_CLIENT_ID;
    const secret = env.SPLITWISE_CLIENT_SECRET;
    if (!cid || !secret) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "❌ Erreur", error: "SPLITWISE_CLIENT_ID and SPLITWISE_CLIENT_SECRET must be set" }, null, 2) }] };
    }
    const r = await fetch("https://secure.splitwise.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: cid,
        client_secret: secret,
        redirect_uri: "https://splitwise.mcp.marchildon.net/callback",
      }),
    });
    const t: any = await r.json().catch(() => ({}));
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: "✅ Token obtenu", access_token: t.access_token ?? "", token_type: t.token_type ?? "" }, null, 2) }] };
  });
}
