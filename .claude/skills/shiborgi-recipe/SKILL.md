---
name: shiborgi-recipe
description: How a shiborgi NanoClaw install is put together — which skills main already carries, the .env an install needs, the order to bring a new install up on a Mac with Apple Container, and how installs take base updates. Use when creating, migrating or updating a shiborgi install (bartender, butler, or a new one).
---

# The shiborgi install recipe

`shiborgi/nanoclaw` is upstream NanoClaw plus skills, applied in `main` as
ordinary commits. An install (`shiborgi/bartender`, `shiborgi/butler`, …) is a
checkout of that `main` plus only what is its own.

## What main already carries

| Skill | Why |
|---|---|
| `add-apple-container` | Sessions run as Apple Container VMs on a host-only network |
| `add-custom-gateway` | The only way out of a session: models by alias, MCP routes, Google |
| `add-opencode` | The agent provider (OpenCode Go through the gateway) |
| `add-whatsapp` | The channel |
| `add-gmail-relay` | Gmail → WhatsApp broadcasts without waking the model |

Per install, never in main: personas under `templates/`
(gitignored), `groups/`, `data/`, `store/`, `.env`.

## A new install on a Mac

Keep the checkout under your home directory, on its real path (not through a
symlink): Apple Container's builder cannot read a build context under `/tmp`,
macOS caps the host's socket paths at 104 bytes, and the shell scripts and the
host would derive different install slugs from a symlinked path.

1. Clone `main`, `pnpm install --frozen-lockfile`, and in
   `container/agent-runner` run `bun install --frozen-lockfile`.
2. Write `.env`:

   ```
   TZ=America/Sao_Paulo
   NANOCLAW_RUNTIME_DRIVER=apple-container
   CONTAINER_RUNTIME=container
   CONTAINER_BUILD_OPTIONS=--cpus 4 --memory 8192mb --build-arg BUN_INSTALL_ATTEMPTS=6
   NANOCLAW_GATEWAY_PROVIDER=custom-gateway
   DEFAULT_AGENT_PROVIDER=opencode
   OPENCODE_PROVIDER=opencode-go
   OPENCODE_MODEL=opencode-go/deepseek-v4-flash
   OPENCODE_SMALL_MODEL=opencode-go/deepseek-v4-flash
   ```

   Set `WEBHOOK_PORT` when another service on the Mac holds 3000.
   `DEFAULT_AGENT_PROVIDER` must be in place before the first agent group is
   created; a group keeps the provider it was created with.
3. `pnpm exec tsx .claude/skills/add-custom-gateway/scripts/setup.ts` — install
   secret, `data/custom-gateway/config/`, gateway image.
4. Fill `gateway.json` and `secrets.env`. OpenCode Go needs the `zen-go`
   upstream and a model alias for the bare model id
   (`deepseek-v4-flash`). Connect Google with
   `scripts/google-oauth-connect.ts <profile>`.
5. `./container/build.sh build` — a few minutes; `bun install` may report a
   stalled attempt and retry, which is expected on this builder.
6. `pnpm exec tsx scripts/upgrade-state.ts set`. The host refuses to start on a
   commit it has not been told about; repeat this after any manual pull (an
   update through `/update-nanoclaw` records it itself).
7. Install and start the service, link WhatsApp (`/add-whatsapp`'s auth step),
   and create the agent groups.
8. Add each group to `gateway.json`'s `agents`, then, with the service up,
   `pnpm exec tsx .claude/skills/add-custom-gateway/scripts/routes.ts sync`
   and restart the groups.

What a healthy install shows: `Gateway provider selected` (`custom-gateway`),
`Session runtime driver selected` (`apple-container`), and on the first message
`Custom gateway lease` followed by `Session egress confined to host-only
network`. From inside a session, `host.docker.internal:8080` answers and
nothing else does.

## Taking base updates

Each install has a `base` remote pointing at `shiborgi/nanoclaw`; update with
`/update-nanoclaw` (`scripts/update-nanoclaw.ts --remote base`). When an update
changes `.claude/skills/add-custom-gateway/service/`, rerun its `setup.ts`.
