/**
 * MCP server logic for Splitwise.
 *
 * This is transport-agnostic: it takes a Splitwise bearer token (an OAuth
 * access token belonging to a specific user) and runs the MCP server against
 * that user's Splitwise account. It is invoked by the OAuth-protected
 * handler in index.ts with the authenticated user's token — never with a
 * shared/personal key.
 *
 * Tools are organised one per REST resource (user, friends, groups, expenses,
 * comments, notifications, categories, currencies), each dispatching on an
 * required `action` argument.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { SplitwiseClient } from "./splitwise";
import {
  buildCreateExpensePayload,
  buildUpdateExpensePayload,
  type CreateExpenseArgs,
  type UpdateExpenseArgs,
} from "./expense";

const GROUP_TYPES = [
  "home",
  "trip",
  "couple",
  "other",
  "apartment",
  "house",
] as const;

/**
 * Run the MCP server for a single authenticated user's Splitwise token.
 * Stateless: each request creates a fresh server/transport, so it fits
 * Cloudflare Workers.
 */
export async function handleMcpRequest(
  request: Request,
  accessToken: string
): Promise<Response> {
  const client = new SplitwiseClient(accessToken);
  const server = new McpServer({
    name: "Splitwise MCP Server",
    version: "2.0.0",
  });

  registerTools(server, client);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function jsonOut(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorOut(e: any) {
  return jsonOut({ status: "❌ Erreur", error: e?.message ?? String(e) });
}

function requireId(
  args: Record<string, any>,
  key: string,
  action: string
): number {
  const v = args[key];
  if (v === undefined || v === null) {
    throw new Error(`Action '${action}' requires '${key}'.`);
  }
  return v;
}

function requireStr(
  args: Record<string, any>,
  key: string,
  action: string
): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`Action '${action}' requires '${key}'.`);
  }
  return v;
}

// --------------------------------------------------------------------------
// Tool registration
// --------------------------------------------------------------------------

export function registerTools(server: McpServer, client: SplitwiseClient) {
  // ========================================================================
  // 1. splitwise_user
  // ========================================================================
  server.tool(
    "splitwise_user",
    "Manage your Splitwise user profile.",
    {
      action: z
        .enum(["get_current", "get", "update"])
        .describe("Action to perform"),
      user_id: z
        .number()
        .int()
        .optional()
        .describe("Required for 'get' and 'update'"),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
      locale: z.string().optional(),
      default_currency: z.string().optional(),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "get_current": {
            const u = await client.getCurrentUser();
            return jsonOut({
              user: {
                id: u.id,
                first_name: u.first_name,
                last_name: u.last_name,
                email: u.email,
                default_currency: (u as any).default_currency,
                locale: (u as any).locale,
              },
            });
          }
          case "get":
            return jsonOut({
              user: await client.getUser(
                requireId(args, "user_id", "get")
              ),
            });
          case "update": {
            const id = requireId(args, "user_id", "update");
            return jsonOut({
              user: await client.updateUser(id, {
                first_name: args.first_name,
                last_name: args.last_name,
                email: args.email,
                locale: args.locale,
                default_currency: args.default_currency,
              }),
            });
          }
        }
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  // ========================================================================
  // 2. splitwise_friends
  // ========================================================================
  server.tool(
    "splitwise_friends",
    "Manage your Splitwise friends. Add by email (invite), list, get details, or delete.",
    {
      action: z
        .enum(["list", "get", "add", "add_many", "delete"])
        .describe("Action to perform"),
      friend_id: z
        .number()
        .int()
        .optional()
        .describe("Required for 'get' and 'delete'"),
      email: z
        .string()
        .optional()
        .describe("Required for 'add' (invite by email)"),
      first_name: z.string().optional().describe("Friend's first name"),
      last_name: z.string().optional().describe("Friend's last name"),
      friends: z
        .array(
          z.object({
            email: z.string().describe("Email address"),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
          })
        )
        .optional()
        .describe("Required for 'add_many' (array of friends)"),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "list":
            return jsonOut({ friends: await client.getFriends() });
          case "get":
            return jsonOut({
              friend: await client.getFriend(
                requireId(args, "friend_id", "get")
              ),
            });
          case "add": {
            const email = requireStr(args, "email", "add");
            return jsonOut({
              friend: await client.createFriend(
                email,
                args.first_name,
                args.last_name
              ),
            });
          }
          case "add_many": {
            if (!args.friends || args.friends.length === 0) {
              throw new Error("Action 'add_many' requires a non-empty 'friends' array.");
            }
            const result = await client.createFriends(args.friends);
            return jsonOut({
              users: result.users,
              errors: result.errors,
            });
          }
          case "delete":
            return jsonOut({
              result: await client.deleteFriend(
                requireId(args, "friend_id", "delete")
              ),
            });
        }
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  // ========================================================================
  // 3. splitwise_groups
  // ========================================================================
  server.tool(
    "splitwise_groups",
    "Manage your groups. List, get details, create, delete, restore, add/remove users.",
    {
      action: z
        .enum(["list", "get", "create", "delete", "restore", "add_user", "remove_user"])
        .describe("Action to perform"),
      group_id: z
        .number()
        .int()
        .optional()
        .describe("Required for 'get', 'delete', 'restore', 'add_user', 'remove_user'"),
      name: z
        .string()
        .optional()
        .describe("Required for 'create'"),
      group_type: z
        .enum(GROUP_TYPES)
        .optional()
        .describe("Group type (default: 'other')"),
      simplify_by_default: z
        .boolean()
        .optional()
        .describe("Turn on simplify debts? (default: false)"),
      members: z
        .array(
          z.object({
            user_id: z.number().int().optional(),
            email: z.string().optional(),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
          })
        )
        .optional()
        .describe("Members to add when creating (by user_id, or email+name to invite)"),
      user_id: z
        .number()
        .int()
        .optional()
        .describe("User to add/remove (required for 'remove_user', optional for 'add_user')"),
      email: z
        .string()
        .optional()
        .describe("Invite a user to the group by email (for 'add_user')"),
      first_name: z
        .string()
        .optional()
        .describe("Member's first name (required when inviting by email)"),
      last_name: z
        .string()
        .optional()
        .describe("Member's last name"),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "list":
            return jsonOut({ groups: await client.getGroups() });
          case "get":
            return jsonOut({
              group: await client.getGroup(
                requireId(args, "group_id", "get")
              ),
            });
          case "create": {
            const name = requireStr(args, "name", "create");
            return jsonOut({
              group: await client.createGroup(
                name,
                {
                  group_type: args.group_type,
                  simplify_by_default: args.simplify_by_default,
                },
                args.members ?? []
              ),
            });
          }
          case "delete":
            return jsonOut({
              result: await client.deleteGroup(
                requireId(args, "group_id", "delete")
              ),
            });
          case "restore":
            return jsonOut({
              result: await client.undeleteGroup(
                requireId(args, "group_id", "restore")
              ),
            });
          case "add_user": {
            const gid = requireId(args, "group_id", "add_user");
            const payload: {
              group_id: number;
              user_id?: number;
              email?: string;
              first_name?: string;
              last_name?: string;
            } = { group_id: gid };
            if (args.user_id !== undefined) payload.user_id = args.user_id;
            if (args.email !== undefined) payload.email = args.email;
            if (args.first_name !== undefined) payload.first_name = args.first_name;
            if (args.last_name !== undefined) payload.last_name = args.last_name;
            if (payload.user_id === undefined && payload.email === undefined) {
              throw new Error("Action 'add_user' requires 'user_id' or 'email'.");
            }
            return jsonOut({
              result: await client.addUserToGroup(payload),
            });
          }
          case "remove_user": {
            const gid = requireId(args, "group_id", "remove_user");
            const uid = requireId(args, "user_id", "remove_user");
            return jsonOut({
              result: await client.removeUserFromGroup(gid, uid),
            });
          }
        }
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  // ========================================================================
  // 4. splitwise_expenses
  // ========================================================================
  server.tool(
    "splitwise_expenses",
    "Manage expenses. Create, list, get, update, delete, or restore. Supports equal splits, custom shares, and inviting new participants by email.",
    {
      action: z
        .enum(["list", "get", "create", "update", "delete", "restore"])
        .describe("Action to perform"),
      expense_id: z
        .number()
        .int()
        .optional()
        .describe("Required for 'get', 'update', 'delete', 'restore'"),
      // List filters
      group_id: z
        .number()
        .int()
        .optional()
        .describe("Filter by group ID (0 = non-grouped, >0 = real group)"),
      friend_id: z
        .number()
        .int()
        .optional()
        .describe("Filter by friend ID"),
      dated_after: z.string().optional().describe("List: only expenses after this date (YYYY-MM-DD)"),
      dated_before: z.string().optional().describe("List: only expenses before this date (YYYY-MM-DD)"),
      updated_after: z.string().optional().describe("List: only expenses updated after this date"),
      updated_before: z.string().optional().describe("List: only expenses updated before this date"),
      limit: z.number().int().default(50).describe("Max results (list)"),
      offset: z.number().int().default(0).describe("Pagination offset (list)"),
      // Create / update fields
      description: z
        .string()
        .optional()
        .describe("Description (required for 'create', optional for 'update')"),
      cost: z
        .number()
        .optional()
        .describe("Total cost (required for 'create', optional for 'update')"),
      currency_code: z
        .string()
        .default("USD")
        .describe("Currency code (USD, CAD, EUR…)"),
      friend_ids: z
        .array(z.number().int())
        .optional()
        .describe("Friend user IDs to include (equal split)"),
      split_equally: z
        .boolean()
        .default(true)
        .describe("Split equally (default true; ignored when 'shares' is provided)"),
      payment: z.boolean().default(false).describe("Mark as a payment"),
      details: z.string().optional(),
      date: z.string().optional().describe("Date YYYY-MM-DD"),
      category_id: z.number().int().optional().describe("Category ID"),
      shares: z
        .array(
          z.object({
            user_id: z.number().int().optional(),
            email: z.string().optional(),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            paid_share: z.union([z.number(), z.string()]).describe("Amount paid by this participant"),
            owed_share: z.union([z.number(), z.string()]).describe("Amount owed by this participant"),
          })
        )
        .optional()
        .describe(
          "Explicit per-participant shares (overrides automatic split; must include the current user by user_id)"
        ),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "list":
            return jsonOut({
              expenses: await client.getExpenses({
                group_id: args.group_id,
                friend_id: args.friend_id,
                dated_after: args.dated_after,
                dated_before: args.dated_before,
                updated_after: args.updated_after,
                updated_before: args.updated_before,
                limit: args.limit,
                offset: args.offset,
              }),
            });

          case "get":
            return jsonOut({
              expense: await client.getExpense(
                requireId(args, "expense_id", "get")
              ),
            });

          case "create": {
            if (!args.description) {
              throw new Error("Action 'create' requires 'description'.");
            }
            if (args.cost === undefined) {
              throw new Error("Action 'create' requires 'cost'.");
            }
            const current = await client.getCurrentUser();
            if (current.id === undefined) {
              throw new Error("Could not determine the current user.");
            }
            const payload = buildCreateExpensePayload(
              args as CreateExpenseArgs,
              current.id
            );
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
          }

          case "update": {
            const eid = requireId(args, "expense_id", "update");
            const current = await client.getCurrentUser();
            if (current.id === undefined) {
              throw new Error("Could not determine the current user.");
            }
            const payload = buildUpdateExpensePayload(
              args as UpdateExpenseArgs,
              current.id
            );
            const updated = await client.updateExpense(eid, payload);
            return jsonOut({
              status: "✅ Dépense mise à jour",
              expense: updated,
            });
          }

          case "delete":
            return jsonOut({
              result: await client.deleteExpense(
                requireId(args, "expense_id", "delete")
              ),
            });

          case "restore":
            return jsonOut({
              result: await client.undeleteExpense(
                requireId(args, "expense_id", "restore")
              ),
            });
        }
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  // ========================================================================
  // 5. splitwise_comments
  // ========================================================================
  server.tool(
    "splitwise_comments",
    "Manage comments on expenses. List, add, or delete.",
    {
      action: z
        .enum(["list", "add", "delete"])
        .describe("Action to perform"),
      expense_id: z
        .number()
        .int()
        .optional()
        .describe("Required for 'list' and 'add'"),
      comment_id: z
        .number()
        .int()
        .optional()
        .describe("Required for 'delete'"),
      content: z
        .string()
        .optional()
        .describe("Required for 'add'"),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "list":
            return jsonOut({
              comments: await client.getComments(
                requireId(args, "expense_id", "list")
              ),
            });
          case "add": {
            const eid = requireId(args, "expense_id", "add");
            const content = requireStr(args, "content", "add");
            return jsonOut({
              comment: await client.createComment(eid, content),
            });
          }
          case "delete":
            return jsonOut({
              comment: await client.deleteComment(
                requireId(args, "comment_id", "delete")
              ),
            });
        }
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  // ========================================================================
  // 6. splitwise_notifications
  // ========================================================================
  server.tool(
    "splitwise_notifications",
    "List your notifications.",
    {
      action: z.enum(["list"]).describe("Action (only 'list' supported)"),
      updated_after: z.string().optional(),
      limit: z.number().int().optional(),
    },
    async (args) => {
      try {
        return jsonOut({
          notifications: await client.getNotifications({
            updated_after: args.updated_after,
            limit: args.limit,
          }),
        });
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  // ========================================================================
  // 7. splitwise_categories
  // ========================================================================
  server.tool(
    "splitwise_categories",
    "List all supported expense categories.",
    { action: z.enum(["list"]).describe("Action (only 'list' supported)") },
    async (_args) => {
      try {
        return jsonOut({ categories: await client.getCategories() });
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );

  // ========================================================================
  // 8. splitwise_currencies
  // ========================================================================
  server.tool(
    "splitwise_currencies",
    "List all supported currencies.",
    { action: z.enum(["list"]).describe("Action (only 'list' supported)") },
    async (_args) => {
      try {
        return jsonOut({ currencies: await client.getCurrencies() });
      } catch (e: any) {
        return errorOut(e);
      }
    }
  );
}