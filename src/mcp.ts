/**
 * MCP server logic for Splitwise.
 *
 * This is transport-agnostic: it takes a Splitwise bearer token (an OAuth
 * access token belonging to a specific user) and runs the MCP server against
 * that user's Splittwise account. It is invoked by the OAuth-protected
 * handler in index.ts with the authenticated user's token — never with a
 * shared/personal key.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { SplitwiseClient } from "./splitwise";

/**
 * Run the MCP server for a single authenticated user's Splitwise token.
 * Stateless: each request creates a fresh server/transport, so it fits
 * Cloudflare Workers.
 */
export async function handleMcpRequest(request: Request, accessToken: string): Promise<Response> {
  const client = new SplitwiseClient(accessToken);
  const server = new McpServer({
    name: "Splitwise MCP Server",
    version: "1.1.0",
  });

  registerTools(server, client);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function jsonOut(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorOut(e: any) {
  return jsonOut({ status: "❌ Erreur", error: e?.message ?? String(e) });
}

export function registerTools(server: McpServer, client: SplitwiseClient) {
  server.tool(
    "splitwise_test_auth",
    "Test the Splitwise API connection for the authenticated user and show their profile info.",
    {},
    async () => {
      try {
        const u = await client.getCurrentUser();
        return jsonOut({
          status: "✅ Authentification réussie",
          user: {
            id: u.id,
            first_name: u.first_name,
            last_name: u.last_name,
            email: u.email,
            default_currency: (u as any).default_currency,
            locale: (u as any).locale,
          },
        });
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  server.tool("splitwise_get_groups", "List all Splitwise groups with their members and balances.", {}, async () => {
    try {
      return jsonOut({ groups: await client.getGroups() });
    } catch (e: any) {
      return errorOut(e);
    }
  });

  server.tool("splitwise_get_friends", "List all Splitwise friends with their balances.", {}, async () => {
    try {
      return jsonOut({ friends: await client.getFriends() });
    } catch (e: any) {
      return errorOut(e);
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
        return jsonOut({
          expenses: await client.getExpenses({ group_id, friend_id, limit, offset }),
        });
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  server.tool(
    "splitwise_create_expense",
    "Create a new expense on the authenticated user's Splitwise account.",
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
        const current = await client.getCurrentUser();
        const cost = String(args.cost);

        const participantIds = args.friend_ids && args.friend_ids.length ? args.friend_ids : [];
        if (!args.group_id && participantIds.length === 0) {
          throw new Error("Provide either a group_id or friend_ids to split the expense with.");
        }

        const users: Record<string, any>[] = [];
        if (participantIds.length > 0) {
          const n = participantIds.length + 1;
          const shareCents = Math.round((Number(cost) * 100) / n);
          const share = (shareCents / 100).toFixed(2);
          // Exact remainder on the last participant so the cost adds up to the cent.
          const remainder = (Number(cost) - shareCents * (n - 1) / 100).toFixed(2);
          users.push({ user_id: current.id, paid_share: cost, owed_share: args.split_equally ? share : "0.00" });
          for (let i = 0; i < participantIds.length; i++) {
            const isLast = i === participantIds.length - 1;
            users.push({
              user_id: participantIds[i],
              paid_share: "0.00",
              owed_share: args.split_equally ? (isLast ? remainder : share) : "0.00",
            });
          }
        } else {
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

        const created = await client.createExpense(payload);
        return jsonOut({
          status: "✅ Dépense créée avec succès",
          expense: {
            id: created?.id ?? null,
            description: created?.description ?? args.description,
            cost: created?.cost ?? args.cost,
            currency_code: args.currency_code,
            group_id: created?.group_id ?? args.group_id ?? null,
            date: created?.date ?? args.date ?? null,
          },
        });
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  server.tool(
    "splitwise_get_group_balances",
    "Get balances for all members in a group.",
    { group_id: z.number().int().describe("The Splitwise group ID") },
    async ({ group_id }) => {
      try {
        return jsonOut({ group: await client.getGroup(group_id) });
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );
}
