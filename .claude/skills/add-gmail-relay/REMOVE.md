# Remove Gmail relay

Every code/configuration step is idempotent. Preserve the durable queue tables
by default so uninstalling cannot erase delivery history without consent.

## 1. Stop scheduled polling

List tasks for every configured agent group, then cancel each live series whose
id starts with `gmail-relay-`:

```bash
ncl tasks list --group <agent-group-id> --json
ncl tasks cancel <gmail-relay-series-id> --group <agent-group-id>
```

## 2. Remove group files

Delete `groups/<agent-folder>/gmail-relay.json`. The cursor under
`groups/<agent-folder>/plugin-data/gmail-relay/` is operational state; delete
that directory too unless it is being retained for a future reinstall.

## 3. Remove code and registration

Delete `import './gmail-relay/index.js';` from `src/modules/index.ts`, then:

```bash
rm -rf src/modules/gmail-relay container/agent-runner/src/gmail-relay
```

Do not drop `gmail_relay_events` or `gmail_relay_deliveries` automatically.
They are module-owned audit/retry history and are inert after the module import
is removed. Destructive cleanup requires explicit operator confirmation and a
current database backup; when confirmed, drop the deliveries table first,
then events.

## 4. Build and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

Removing the relay does not remove the independent read-only Gmail gateway
integration. Use `/add-google`'s removal instructions only if Gmail access
itself should also be revoked.
