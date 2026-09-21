---
name: add-gmail-relay
description: Add deterministic Gmail polling that filters normalized email content and reliably broadcasts matching text to WhatsApp groups wired to a NanoClaw agent group.
---

# Add Gmail relay

Install this capability when Gmail messages should trigger WhatsApp broadcasts
without waking or spending tokens on the language model. The poller runs in the
agent task runtime, reads Gmail only through the gateway, and sends accepted
text to a durable host queue. The host deduplicates on Gmail message id,
retries transient adapter failures, and selects only active WhatsApp wiring for
the caller's agent group.

## Prerequisite

Apply `/add-google` first with the `google-gmail` route and
`gmail.readonly` scope for every target agent group. Confirm `get_profile`
returns the expected mailbox. Never put Google credentials in the relay config.

## 1. Install the skill-owned code

Copy the resources from `${CLAUDE_SKILL_DIR}`. These operations are safe to
repeat and deliberately overwrite only files owned by this skill.

```bash
mkdir -p src/modules/gmail-relay container/agent-runner/src/gmail-relay
cp "${CLAUDE_SKILL_DIR}/resources/host/index.ts" src/modules/gmail-relay/index.ts
cp "${CLAUDE_SKILL_DIR}/resources/host/migration.ts" src/modules/gmail-relay/migration.ts
cp "${CLAUDE_SKILL_DIR}/resources/host/queue.ts" src/modules/gmail-relay/queue.ts
cp "${CLAUDE_SKILL_DIR}/resources/host/integration.test.ts" src/modules/gmail-relay/integration.test.ts
cp "${CLAUDE_SKILL_DIR}/resources/container/poll.ts" container/agent-runner/src/gmail-relay/poll.ts
cp "${CLAUDE_SKILL_DIR}/resources/container/poll.test.ts" container/agent-runner/src/gmail-relay/poll.test.ts
cp "${CLAUDE_SKILL_DIR}/resources/gmail-relay.example.json" container/agent-runner/src/gmail-relay/gmail-relay.example.json
```

Add this single self-registration import to `src/modules/index.ts`, immediately
before the self-mod import. Skip it when already present.

```typescript
import './gmail-relay/index.js';
```

The integration test imports the real module barrel, so it fails if this line
is missing or drifts.

## 2. Configure each mailbox filter

Copy the example to `groups/<agent-folder>/gmail-relay.json`, then replace the
placeholder sender, matching expressions, extracted fields, and template.
Keep `enabled: false` until the rule has been tested against representative
normalized messages.

Every enabled rule must contain:

- at least one positive criterion: sender address/domain, subject/body regex,
  or Gmail label;
- a nonempty output template;
- every field needed for safe forwarding marked `required: true`.

Criteria from different categories are ANDed. Values within sender and label
lists are ORed. Exclusion expressions always win. Rules are evaluated in
order; the first rule whose filters and required extraction fields pass is
used. `source` may be `text`, `textPlain`, or `htmlText`; all three are
normalized text supplied by the gateway, never raw HTML.

`groupsOnly` defaults to true. Set it false only when connected WhatsApp DMs
should also receive a broadcast. `initialLookbackMinutes` defaults to zero,
which establishes a cursor without replaying existing mail on first run.

## 3. Validate before enabling

Run the filter and integration tests, then build both runtimes:

```bash
pnpm exec vitest run src/modules/gmail-relay/integration.test.ts
pnpm run typecheck
cd container/agent-runner
bun test src/gmail-relay/poll.test.ts
pnpm run typecheck
cd ../..
```

For a live filter smoke test, leave `enabled: false` and run the poller inside
an agent container. Its last stdout line must be a JSON object with
`wakeAgent:false` and `status:"disabled"`. Then enable the rule and use a test
email that passes it. Do not use a catch-all rule for testing.

## 4. Schedule polling

First list existing tasks and do not create a duplicate whose series id starts
with `gmail-relay-` and whose script matches the command below.

```bash
ncl tasks list --group <agent-group-id> --json
ncl tasks create --group <agent-group-id> --name gmail-relay \
  --recurrence "*/1 * * * *" \
  --prompt "Gmail relay poll completed deterministically." \
  --script "bun /app/src/gmail-relay/poll.ts /workspace/agent/gmail-relay.json"
```

The script always returns `wakeAgent:false`; a one-minute schedule therefore
does not invoke the model. A script error uses the scheduler's retry/backoff
path instead of silently advancing the Gmail cursor.

## 5. Start and verify

Build the host and restart NanoClaw so the module migration, hidden queue
command, and delivery worker load. Source files under
`container/agent-runner/src` are mounted at `/app/src`, so this poller does not
require an agent image rebuild.

```bash
pnpm run build
bash setup/lib/restart.sh
ncl tasks list --group <agent-group-id> --json
```

After sending one matching test email, verify the task run log reports one
queued message and the target WhatsApp groups receive it once. Re-running the
same Gmail message id must not create another delivery.

## Troubleshooting

- `historyExpired`: expected after a long pause. The poller performs a bounded
  search from the last successful timestamp and then resumes history polling.
- repeated task errors: verify the group has the `google-gmail` gateway route,
  the gateway container is current, and OAuth still covers `gmail.readonly`.
- filter matches nothing: inspect a narrowly selected message with
  `get_message`; write expressions against `text`, `textPlain`, or `htmlText`.
- no WhatsApp delivery: confirm at least one active WhatsApp group is wired to
  the agent and the correct adapter instance is connected.

## Removal

Follow [REMOVE.md](REMOVE.md).
