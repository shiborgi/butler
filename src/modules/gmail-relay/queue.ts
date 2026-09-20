import { createHash } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';

const MAX_ATTEMPTS = 8;
const MAX_BATCH = 100;
const MAX_RETRY_MS = 5 * 60_000;

interface RelayMessage {
  sourceMessageId: string;
  text: string;
  ruleId?: string;
}

interface DeliveryRow {
  id: string;
  event_id: string;
  messaging_group_id: string;
  content: string;
  attempts: number;
  channel_type: string;
  platform_id: string;
  instance: string;
  detached_at: string | null;
}

export interface EnqueueResult {
  accepted: number;
  duplicates: number;
  deliveries: number;
  targets: number;
}

const stableId = (prefix: string, ...parts: string[]): string =>
  `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;

/**
 * Persist relay messages before delivery. The Gmail message id is the
 * idempotency key for one agent group, so overlapping polls cannot fan out a
 * message twice.
 */
export async function enqueueGmailRelay(
  agentGroupId: string,
  messages: readonly RelayMessage[],
  groupsOnly = true,
  db: DbDriver = getDb(),
): Promise<EnqueueResult> {
  const wired = await getMessagingGroupsByAgentGroup(agentGroupId);
  const targets = wired.filter(
    (group) => group.channel_type === 'whatsapp' && !group.detached_at && (!groupsOnly || group.is_group === 1),
  );
  let accepted = 0;
  let duplicates = 0;
  let deliveries = 0;

  await db.transaction(async () => {
    for (const message of messages) {
      const eventId = stableId('gre', agentGroupId, message.sourceMessageId);
      const now = new Date().toISOString();
      const inserted = await db.run(
        `INSERT INTO gmail_relay_events
           (id, agent_group_id, source_message_id, rule_id, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_group_id, source_message_id) DO NOTHING`,
        eventId,
        agentGroupId,
        message.sourceMessageId,
        message.ruleId ?? null,
        message.text,
        now,
      );
      if (inserted.changes === 0) {
        duplicates += 1;
        continue;
      }
      accepted += 1;
      for (const target of targets) {
        const deliveryId = stableId('grd', eventId, target.id);
        const result = await db.run(
          `INSERT INTO gmail_relay_deliveries
             (id, event_id, messaging_group_id, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?)
           ON CONFLICT (event_id, messaging_group_id) DO NOTHING`,
          deliveryId,
          eventId,
          target.id,
          now,
          now,
        );
        deliveries += result.changes;
      }
    }
  });

  return { accepted, duplicates, deliveries, targets: targets.length };
}

let activeDrain: Promise<number> | null = null;

async function drain(db: DbDriver): Promise<number> {
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('Channel delivery adapter is not ready');

  const now = new Date().toISOString();
  const rows = await db.all<DeliveryRow>(
    `SELECT d.id, d.event_id, d.messaging_group_id, d.attempts,
            e.content, mg.channel_type, mg.platform_id, mg.instance,
            mg.detached_at
       FROM gmail_relay_deliveries d
       JOIN gmail_relay_events e ON e.id = d.event_id
       JOIN messaging_groups mg ON mg.id = d.messaging_group_id
      WHERE d.status IN ('pending', 'retry')
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
      ORDER BY d.created_at, d.id
      LIMIT ?`,
    now,
    MAX_BATCH,
  );
  let handled = 0;

  for (const row of rows) {
    const claimed = await db.run(
      `UPDATE gmail_relay_deliveries
          SET status = 'delivering', updated_at = ?
        WHERE id = ? AND status IN ('pending', 'retry')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      now,
      row.id,
      now,
    );
    if (claimed.changes === 0) continue;

    if (row.channel_type !== 'whatsapp' || row.detached_at) {
      await db.run(
        `UPDATE gmail_relay_deliveries
            SET status = 'skipped', last_error = ?, updated_at = ?
          WHERE id = ?`,
        'WhatsApp group is no longer active',
        new Date().toISOString(),
        row.id,
      );
      handled += 1;
      continue;
    }

    try {
      const platformMessageId = await adapter.deliver(
        'whatsapp',
        row.platform_id,
        null,
        'chat',
        JSON.stringify({ text: row.content }),
        undefined,
        row.instance,
      );
      const deliveredAt = new Date().toISOString();
      await db.run(
        `UPDATE gmail_relay_deliveries
            SET status = 'delivered', attempts = attempts + 1,
                delivered_at = ?, platform_message_id = ?, last_error = NULL,
                next_attempt_at = NULL, updated_at = ?
          WHERE id = ?`,
        deliveredAt,
        platformMessageId ?? null,
        deliveredAt,
        row.id,
      );
      handled += 1;
      // eslint-disable-next-line no-catch-all/no-catch-all -- one adapter failure is persisted for retry and must not block sibling groups
    } catch (error) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const delay = Math.min(1000 * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
      const updatedAt = new Date().toISOString();
      await db.run(
        `UPDATE gmail_relay_deliveries
            SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE id = ?`,
        failed ? 'failed' : 'retry',
        attempts,
        failed ? null : new Date(Date.now() + delay).toISOString(),
        error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        updatedAt,
        row.id,
      );
      log.warn('Gmail relay WhatsApp delivery failed', {
        deliveryId: row.id,
        attempts,
        terminal: failed,
        err: error,
      });
    }
  }
  return handled;
}

/** Single-flight queue drain, exported for integration tests and operations. */
export async function drainGmailRelayDeliveries(db: DbDriver = getDb()): Promise<number> {
  if (!activeDrain) {
    activeDrain = drain(db).finally(() => {
      activeDrain = null;
    });
  }
  return activeDrain;
}

/** Recover only abandoned claims; never steal a delivery from another live host. */
export async function recoverStaleGmailRelayDeliveries(db: DbDriver = getDb()): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await db.run(
    `UPDATE gmail_relay_deliveries
        SET status = 'retry', next_attempt_at = NULL, updated_at = ?
      WHERE status = 'delivering' AND updated_at <= ?`,
    new Date().toISOString(),
    cutoff,
  );
}
