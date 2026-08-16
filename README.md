# Splitwise MCP Server (Cloudflare Worker)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/elecnix/splitwise-mcp-server)

A **public MCP server** that exposes the Splitwise API, protected by **OAuth 2.1**: each user connects with **their own Splitwise account**. No one can act on another user's account — in particular not on the owner's.

- **Cost:** $0/mo (Cloudflare Workers free plan, 100,000 requests/day)
- **Security:** multi-user OAuth via `@cloudflare/workers-oauth-provider` (Cloudflare's official OAuth 2.1 implementation)
- **Stack:** TypeScript, Cloudflare Workers, KV, `@modelcontextprotocol/sdk`

## Public server

There is a hosted instance at **`https://splitwise.mcp.marchildon.net/mcp`**. Connect any MCP client to it:

```bash
# mcporter
mcporter config add splitwise https://splitwise.mcp.marchildon.net/mcp --auth oauth
mcporter list splitwise
```

For Claude Desktop or other MCP clients, point them at the `/mcp` URL. The first call opens Splitwise's OAuth consent screen; after you approve, the client stores a token scoped to **your** account.

## Security model

| Element | Detail |
|---|---|
| Public server | holds **only** `SPLITWISE_CLIENT_ID` + `SPLITWISE_CLIENT_SECRET` (app credentials, bound to **no** account) |
| Each user | authorizes their own account via Splitwise's consent screen |
| Per-user token | stored **encrypted** in the OAuth grant (KV) by the Cloudflare provider |
| Splitwise API calls | always made with **the authenticated user's token** |
| `/mcp` | returns 401 without a valid token (`WWW-Authenticate` challenge) |

The personal Splitwise API key (`SPLITWISE_API_KEY`) is **never used** in this worker. It is only for local tool testing (`src/dev_local.ts`, gitignored).

## Tools (8)

One tool per REST resource, dispatching on an `action` argument:

- `splitwise_user` — `get_current` (profile), `get` (another user), `update` (name, email, locale, currency)
- `splitwise_friends` — `list`, `get`, `add` (invite by email), `add_many`, `delete`
- `splitwise_groups` — `list`, `get`, `create`, `delete`, `restore`, `add_user` (by `user_id` or email), `remove_user`
- `splitwise_expenses` — `list`, `get`, `create`, `update`, `delete`, `restore`. Creation supports equal splits (friends or auto-split within a group), custom shares via `shares` (by `user_id` or email — email invites new participants), and solo personal expenses. Form-encoded (`users__N__field`), Splitwise errors surfaced (never a false success).
- `splitwise_comments` — `list`, `add`, `delete`
- `splitwise_notifications` — `list`
- `splitwise_categories` — `list`
- `splitwise_currencies` — `list`

This covers **every endpoint** of the Splitwise OpenAPI spec ([dev.splitwise.com](https://dev.splitwise.com)).

## Self-hosting

This is a Cloudflare Worker. To run your own instance:

### 1. Create the KV namespaces

```bash
wrangler kv namespace create OAUTH_KV   # note the id
wrangler kv namespace create FLOW_KV    # note the id
```

Put the ids in `wrangler.jsonc` (the `id` fields of the two KV bindings).

### 2. Set the secrets

```bash
wrangler secret put SPLITWISE_CLIENT_ID
wrangler secret put SPLITWISE_CLIENT_SECRET
```

### 3. Register the OAuth app in Splitwise

In your Splitwise OAuth app settings, add your redirect URIs:

- `https://<your-domain>/callback` (production)
- `http://localhost:8788/callback` (local development)

### 4. Deploy

```bash
npm install
npm run deploy
```

To use a custom domain, add a route in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "mcp.example.com", "custom_domain": true }]
```

### 5. Verify

```bash
curl -i -X POST https://<your-domain>/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# → expected: 401 + WWW-Authenticate (no access without OAuth)
```

## Local development

```bash
npm install
# real OAuth server on :8788 — check 401, metadata, redirect
npx wrangler dev --local --port 8788
# tool-testing harness on :8787 (personal key, gitignored)
npx wrangler dev --local --config wrangler.dev.jsonc --port 8787
```

## Verification

- Bundle OK (`wrangler deploy --dry-run`)
- All endpoints tested against the real Splitwise API (auth, groups, friends, expenses, create + delete of a test expense, balances)
- Unauthenticated `POST /mcp` → **401 + Bearer challenge**
- OAuth metadata (RFC 8414 / RFC 9728) correct, PKCE S256
- Dynamic client registration (RFC 7591) OK
- `/authorize` → redirect to `secure.splitwise.com/oauth/authorize` (Splitwise consent for the user's account)
