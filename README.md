# Splitwise MCP Server (Cloudflare Worker)

A public, free MCP server that exposes the [Splitwise](https://secure.splitwise.com)
API to any MCP client, deployed on Cloudflare Workers.

- **URL:** `https://splitwise.mcp.marchildon.net`
- **Transport:** MCP Streamable HTTP (POST `JSON-RPC` at the root/`/mcp`)
- **Cost:** $0/month (Workers free plan)
- **Auth:** the Splitwise personal API key is a Worker secret; the MCP layer is
  intentionally public with no auth (per owner's requirement that anyone can use it).

> ⚠️ Making an MCP server that can *create expenses* publicly available means anyone
> can create Splitwise expenses. This is a **privacy/security decision owned by the
> account holder** and is out of scope here. Consider a shared secret / guard if this
> becomes a concern.

## Tools (ported from the Python FastMCP server)

| Tool | Description |
|---|---|
| `splitwise_test_auth` | Test API connection + current user |
| `splitwise_get_groups` | List groups, members, balances |
| `splitwise_get_friends` | List friends + balances |
| `splitwise_get_expenses` | List expenses with filters |
| `splitwise_create_expense` | Create an expense (e.g. 5% aux filles) |
| `splitwise_get_group_balances` | Balances for a group |
| `splitwise_get_oauth_url` | OAuth2 authorize URL |
| `splitwise_exchange_oauth_code` | Exchange OAuth code for token |

## Secrets

Set before deploying:

```bash
wrangler secret put SPLITWISE_API_KEY        # required
# optional:
wrangler secret put SPLITWISE_CLIENT_ID
wrangler secret put SPLITWISE_CLIENT_SECRET
```

## Local dev

```bash
npm install
npx wrangler secret put SPLITWISE_API_KEY   # local as well
npm run dev                                  # http://localhost:8787
```

Point an MCP client at `http://localhost:8787/`.

## Deploy

```bash
npm run deploy
npx wrangler deployments list
```

## Custom domain

```bash
npx wrangler deploy --routes '[{"pattern":"splitwise.mcp.marchildon.net/*","custom_domain":true}]'
```

Then add the DNS record Cloudflare prints (CNAME) and wait for SSL.
