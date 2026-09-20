import { registerMigration } from '../../db/migrations/index.js';

/** Durable outbox owned by the Gmail relay module. */
export const gmailRelayQueueMigration = {
  version: 1,
  name: 'module:gmail-relay:queue-v1' as const,
  async up(db: import('../../db/driver.js').DbDriver): Promise<void> {
    await db.exec(`
      CREATE TABLE gmail_relay_events (
        id                TEXT PRIMARY KEY,
        agent_group_id    TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        source_message_id TEXT NOT NULL,
        rule_id           TEXT,
        content           TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        UNIQUE (agent_group_id, source_message_id)
      );

      CREATE TABLE gmail_relay_deliveries (
        id                  TEXT PRIMARY KEY,
        event_id            TEXT NOT NULL REFERENCES gmail_relay_events(id) ON DELETE CASCADE,
        messaging_group_id  TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        status              TEXT NOT NULL,
        attempts            INTEGER NOT NULL DEFAULT 0,
        next_attempt_at     TEXT,
        delivered_at        TEXT,
        platform_message_id TEXT,
        last_error          TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (event_id, messaging_group_id)
      );

      CREATE INDEX idx_gmail_relay_deliveries_due
        ON gmail_relay_deliveries (status, next_attempt_at, created_at);
    `);
  },
};

registerMigration(gmailRelayQueueMigration);
