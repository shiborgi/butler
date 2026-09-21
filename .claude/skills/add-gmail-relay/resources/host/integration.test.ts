import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The production barrel is the feature's only integration point. Importing it
// proves both the module migration and hidden CLI command self-register.
import '../index.js';
import { dispatch } from '../../cli/dispatch.js';
import { lookup } from '../../cli/registry.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  setMessagingGroupDetachedAt,
} from '../../db/messaging-groups.js';
import { getRegisteredMigrations } from '../../db/migrations/index.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { drainGmailRelayDeliveries } from './queue.js';

const now = (): string => new Date().toISOString();

async function seedGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

async function wire(
  agentGroupId: string,
  id: string,
  channelType: string,
  platformId: string,
  options: { instance?: string; isGroup?: boolean; detached?: boolean } = {},
): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    instance: options.instance,
    name: id,
    is_group: options.isGroup === false ? 0 : 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: `wire-${id}`,
    messaging_group_id: id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
  if (options.detached) await setMessagingGroupDetachedAt(id, now());
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await seedGroup('ag-relay');
  await seedGroup('ag-other');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

describe('gmail relay composition', () => {
  it('registers its migration and hidden command through the module barrel', async () => {
    expect(getRegisteredMigrations().some((migration) => migration.name === 'module:gmail-relay:queue-v1')).toBe(true);
    expect(lookup('gmail-relay-broadcast')?.access).toBe('hidden');
    expect(await getDb().hasTable('gmail_relay_deliveries')).toBe(true);
  });

  it('delivers once to every active WhatsApp group wired to the caller, preserving instances', async () => {
    await wire('ag-relay', 'wa-a', 'whatsapp', '12001@g.us', { instance: 'sales' });
    await wire('ag-relay', 'wa-b', 'whatsapp', '12002@g.us', { instance: 'support' });
    await wire('ag-relay', 'wa-dm', 'whatsapp', '55119999@s.whatsapp.net', { isGroup: false });
    await wire('ag-relay', 'telegram', 'telegram', 'tg-1');
    await wire('ag-relay', 'detached', 'whatsapp', '12003@g.us', { detached: true });
    await wire('ag-other', 'other', 'whatsapp', '12004@g.us');

    const deliveries: Array<{ platformId: string; instance?: string; content: string }> = [];
    setDeliveryAdapter({
      async deliver(_channel, platformId, _thread, _kind, content, _files, instance) {
        deliveries.push({ platformId, instance, content });
        return `sent-${platformId}`;
      },
    });

    const request = {
      id: 'req-1',
      command: 'gmail-relay-broadcast',
      args: { messages: [{ source_message_id: 'gmail-1', rule_id: 'orders', text: 'Pedido 42' }] },
    };
    const ctx = {
      caller: 'agent' as const,
      sessionId: 'session-1',
      agentGroupId: 'ag-relay',
      messagingGroupId: 'wa-a',
    };
    expect((await dispatch(request, ctx)).ok).toBe(true);
    await drainGmailRelayDeliveries();

    expect(deliveries.sort((a, b) => a.platformId.localeCompare(b.platformId))).toEqual([
      { platformId: '12001@g.us', instance: 'sales', content: JSON.stringify({ text: 'Pedido 42' }) },
      { platformId: '12002@g.us', instance: 'support', content: JSON.stringify({ text: 'Pedido 42' }) },
    ]);

    expect((await dispatch({ ...request, id: 'req-2' }, ctx)).ok).toBe(true);
    await drainGmailRelayDeliveries();
    expect(deliveries).toHaveLength(2);
  });

  it('retries an adapter failure and never advances it as delivered', async () => {
    await wire('ag-relay', 'wa-a', 'whatsapp', '12001@g.us');
    const deliver = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('sent-1');
    setDeliveryAdapter({ deliver });
    const response = await dispatch(
      {
        id: 'req-retry',
        command: 'gmail-relay-broadcast',
        args: { messages: [{ source_message_id: 'gmail-retry', text: 'Retry me' }] },
      },
      {
        caller: 'agent',
        sessionId: 'session-1',
        agentGroupId: 'ag-relay',
        messagingGroupId: 'wa-a',
      },
    );
    expect(response.ok).toBe(true);
    await drainGmailRelayDeliveries();
    const retry = await getDb().get<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM gmail_relay_deliveries',
    );
    expect(retry).toEqual({ status: 'retry', attempts: 1 });

    await getDb().run("UPDATE gmail_relay_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
    await drainGmailRelayDeliveries();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((await getDb().get<{ status: string }>('SELECT status FROM gmail_relay_deliveries'))?.status).toBe(
      'delivered',
    );
  });
});
