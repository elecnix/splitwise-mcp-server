# Splitwise MCP Server (Cloudflare Worker)

Un serveur MCP **public** qui expose l'API Splitwise, protégé par **OAuth 2.1** :
chaque utilisateur se connecte avec **son propre compte Splitwise**. Personne
ne peut agir sur le compte d'un autre utilisateur — en particulier pas sur
celui du propriétaire.

- **Coût : 0 $/mois** (plan gratuit Cloudflare Workers, 100 000 requêtes/jour)
- **Adresse (prévue) :** `https://splitwise.mcp.marchildon.net/mcp`
- **Sécurité :** OAuth multi-utilisateur via `@cloudflare/workers-oauth-provider`
  (implémentation OAuth 2.1 officielle de Cloudflare)

## Modèle de sécurité

| Élément | Détail |
|---|---|
| Serveur public | ne détient **que** `SPLITWISE_CLIENT_ID` + `SPLITWISE_CLIENT_SECRET` (credentials d'application, liés à AUCUN compte) |
| Chaque utilisateur | autorise son propre compte via l'écran de consentement Splitwise |
| Token par utilisateur | stocké **chiffré** dans le grant OAuth (KV) par le provider Cloudflare |
| Appels API Splitwise | toujours faits avec **le token de l'utilisateur authentifié** |
| `/mcp` | 401 sans token valide (challenge `WWW-Authenticate`) |

La clé API personnelle de Splitwise (`SPLITWISE_API_KEY`) **n'est jamais
utilisée dans ce worker public**. Elle ne sert qu'aux tests locaux
(`src/dev_local.ts`, gitignoré).

## Outils MCP (8)

Chaque outil regroupe toutes les actions d'une ressource REST via un paramètre `action` :

- `splitwise_user` — actions : `get_current` (profil), `get` (autre utilisateur),
  `update` (profil : nom, email, locale, devise)
- `splitwise_friends` — actions : `list`, `get`, `add` (inviter par email),
  `add_many` (invitation groupée), `delete`
- `splitwise_groups` — actions : `list`, `get`, `create`, `delete`, `restore`,
  `add_user` (par user_id ou email), `remove_user`
- `splitwise_expenses` — actions : `list`, `get`, `create`, `update`, `delete`,
  `restore`. Création : partage égal (avec amis ou dans un groupe automatique),
  partage personnalisé (via `shares`), invitation de nouveaux participants
  par email. Envoi form-encoded (format `users__N__champ`), erreurs Splitwise
  remontées.
- `splitwise_comments` — actions : `list`, `add`, `delete`
- `splitwise_notifications` — actions : `list`
- `splitwise_categories` — actions : `list`
- `splitwise_currencies` — actions : `list`

## Déploiement

### 1. Créer les ressources Cloudflare

```bash
wrangler kv namespace create OAUTH_KV   # → noter l'id
wrangler kv namespace create FLOW_KV    # → noter l'id
```

Renseigner les ids dans `wrangler.jsonc` (champs `id` des deux bindings KV).

### 2. Secrets

```bash
wrangler secret put SPLITWISE_CLIENT_ID
wrangler secret put SPLITWISE_CLIENT_SECRET
```

### 3. Enregistrer la redirection dans Splitwise

Dans les réglages de l'application Splitwise (client OAuth), ajouter les
redirections :

- `https://splitwise.mcp.marchildon.net/callback` (production)
- `http://localhost:8788/callback` (tests locaux)

### 4. Déployer + DNS

```bash
npm run deploy
wrangler deploy --routes '[{"pattern":"splitwise.mcp.marchildon.net/*","custom_domain":true}]'
```

### 5. Vérifier

```bash
curl -i -X POST https://splitwise.mcp.marchildon.net/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# → attendu : 401 + WWW-Authenticate (aucun accès sans OAuth)
```

## Tests locaux

```bash
npm install
# serveur réel (OAuth) sur :8788 — vérifier 401, métadonnées, redirection
npx wrangler dev --local --port 8788
# harness de tests des outils sur :8787 (clé perso locale, gitignoré)
npx wrangler dev --local --config wrangler.dev.jsonc --port 8787
```

## Vérifications effectuées

- Bundle OK (`wrangler deploy --dry-run`)
- Les 6 outils testés contre l'API Splitwise réelle (auth, groupes, amis,
  dépenses, création + suppression d'une dépense de test, soldes)
- `POST /mcp` non authentifié → **401 + challenge Bearer**
- Métadonnées OAuth (RFC 8414 / RFC 9728) correctes, PKCE S256
- Enregistrement client dynamique (RFC 7591) OK
- `/authorize` → redirection vers `secure.splitwise.com/oauth/authorize`
  (consentement Splitwise pour le compte de l'utilisateur)