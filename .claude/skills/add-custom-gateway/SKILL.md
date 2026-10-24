---
name: add-custom-gateway
description: Install or refresh the custom gateway — a small self-hosted service that holds every upstream credential, routes model aliases to upstreams, and serves remote MCP servers plus built-in Google Drive, Sheets, Calendar, Tasks and Gmail tools, with a per-agent-group policy. Use when selecting the custom gateway, adding a model upstream or MCP route, connecting a Google account, or restoring the gateway after an update.
---

# Custom gateway

One gateway container per install, owned by the install rather than by any
session. Agents never hold a credential: every model call and every MCP call
goes to the gateway, which checks the calling group's policy, adds the upstream
credential, and forwards. The gateway sits on two networks — the runtime's
default network for the internet, and the install's host-only egress network
where sessions live — so on a driver that confines sessions to that network
(`/add-apple-container`) the gateway is their only way out.

Each agent group gets its own client key, `ncl.<group id>.<mac>`, an HMAC of the
group id under the install secret `NANOCLAW_GATEWAY_SECRET`. The gateway
recomputes it, so it keeps no per-group state and a group cannot use a sibling's
policy. The key travels as a path prefix, `http://host.docker.internal:8080/g/<key>/…`,
which lets stock model clients (OpenCode sends a fixed placeholder token) and MCP
clients reach the gateway without any change. The key is an identity, not an
upstream credential; the gateway never logs request paths.

Policy lives in `data/custom-gateway/config/gateway.json` (models, upstreams,
MCP routes, OAuth profiles, and which group may use what) and values in
`data/custom-gateway/config/secrets.env` (owner-only). Both are read per request,
so edits and key rotation apply on the next call without a restart. Both sit
under `data/`, so they are in the install's snapshots and never in git.

## Install the provider payload

```nc:copy
payload/src/gateway-providers/custom-gateway.ts -> src/gateway-providers/custom-gateway.ts
payload/src/gateway-providers/custom-gateway.test.ts -> src/gateway-providers/custom-gateway.test.ts
payload/src/gateway-providers/custom-gateway-container.ts -> src/gateway-providers/custom-gateway-container.ts
payload/src/gateway-providers/custom-gateway-container.test.ts -> src/gateway-providers/custom-gateway-container.test.ts
payload/src/gateway-providers/custom-gateway-identity.ts -> src/gateway-providers/custom-gateway-identity.ts
payload/src/gateway-providers/custom-gateway-registration.test.ts -> src/gateway-providers/custom-gateway-registration.test.ts
payload/container/skills/custom-gateway/SKILL.md -> container/skills/custom-gateway/SKILL.md
payload/container/skills/custom-gateway/instructions.md -> container/skills/custom-gateway/instructions.md
```

The provider file makes the only registration call:

```nc:append to:src/gateway-providers/installed.ts
import './custom-gateway.js';
```

## Build the gateway

Setup creates the install secret if there is none, scaffolds `gateway.json` and
`secrets.env` from `service/config/*.example` the first time (it never
overwrites them), builds the image `nanoclaw-custom-gateway-<slug>:latest` with
this install's container runtime, and removes the running gateway so the next
session starts it on the new image. Sessions are never kept waiting on a build:
a missing image fails the session with the command to run.

```nc:run effect:step
pnpm exec tsx .claude/skills/add-custom-gateway/scripts/setup.ts
```

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/custom-gateway.test.ts src/gateway-providers/custom-gateway-container.test.ts src/gateway-providers/custom-gateway-registration.test.ts src/gateway-providers/gateway-provider-registry.test.ts .claude/skills/add-custom-gateway/scripts
```

```nc:run effect:test
cd .claude/skills/add-custom-gateway/service && bun test
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=custom-gateway` after every
directive succeeds. Restart this copy's service; the log names
`Gateway provider selected` with `gatewayProvider: custom-gateway`, and the first
session logs `Custom gateway container running`.

## Configure

Edit `data/custom-gateway/config/gateway.json`:

- **`upstreams`** — `baseUrl` with its version prefix, and `auth` naming the
  header, the format (`Bearer {value}`) and the key in `secrets.env`.
- **`models`** — alias → upstream and the upstream's model name. Agents ask for
  the alias; keep one for the exact id the agent provider sends (for OpenCode,
  `OPENCODE_MODEL` without its provider prefix, and with it).
- **`mcpServers`** — a remote `url` with optional `auth`, or a `builtin`
  (`google-drive`, `google-calendar`, `google-tasks`, `google-gmail`) with
  `{"kind":"oauth2","profile":"<name>"}`. Drive includes Sheets.
- **`fileRoutes`** — read-only routes for files an agent saves to disk (a
  listing's photo), so the bytes reach the file without passing through the
  model: `{"url": "http://host:port/photos", "contentTypes": ["image/"],
  "maxBytes": 10000000}`. The agent reads `$NANOCLAW_GATEWAY_URL/files/<name>/<path>`
  with GET or HEAD; only the listed content types and sizes come back, plain
  path segments only, and none of the agent's headers are forwarded.
- **`agents`** — per agent group id, the model aliases, MCP servers and file
  routes (`files`) it may use; `*` is the fallback for groups without an entry.

Put values in `secrets.env`. For a provider's own setup (`/add-opencode` and
others), the credential prompt stores the key under the `auth.secret` of the
upstream on that host; add the upstream first.

The gateway reaches upstreams over IPv4 first. Host-network paths that
black-hole IPv6 would otherwise hang every call until timeout.

### Give groups their MCP servers

The policy decides what a group may reach; the group's container config decides
what its agent tries. After changing a group's `mcpServers`, with the service
running:

```bash
pnpm exec tsx .claude/skills/add-custom-gateway/scripts/routes.ts sync [--group <id>] [--dry-run]
```

It adds one HTTP MCP entry per allowed route through `ncl groups config
add-mcp-server`, then prints the `ncl groups restart` to run. It prints route
names only — the URLs carry the group's key.

### Connect a Google account

Add an `oauthProfiles` entry with the account's `expectedEmail` and scopes, put
the OAuth client id and secret in `secrets.env`, then:

```bash
GOOGLE_OAUTH_PORT=8765 pnpm exec tsx .claude/skills/add-custom-gateway/scripts/google-oauth-connect.ts <profile>
```

On a headless host, forward the port first (`ssh -L 8765:127.0.0.1:8765 <host>`)
and open the printed URL locally. The refresh token is written to `secrets.env`
and never printed; a different account than `expectedEmail` is refused.

## After an update

A refresh copies the provider code only. When the update changed this skill's
`service/`, run `scripts/setup.ts` again to rebuild the image.

## Troubleshooting

- **`the custom gateway image … does not exist`** — run `scripts/setup.ts`.
- **`NANOCLAW_GATEWAY_SECRET is not set`** — run `scripts/setup.ts`; it creates
  one. Changing the secret changes every group's key: rerun `routes.ts sync`.
- **`… is not answering /health/live`** — read `container logs` (or `docker logs`)
  for `nanoclaw-gateway-v2-<slug>`; a `gateway.json` the service cannot parse
  is the usual cause.
- **The agent gets 401** — the session started before a secret change; restart
  the group. **403** — the policy does not allow that model or MCP server for
  the group. **502** — the upstream failed or its key is missing in `secrets.env`.
