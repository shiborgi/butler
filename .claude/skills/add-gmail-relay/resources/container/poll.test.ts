import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { pollGmailRelay, renderMatchingMessage, type GmailRelayConfig } from './poll.js';

const tempDirs: string[] = [];

async function files(config: GmailRelayConfig): Promise<{ configPath: string; statePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gmail-relay-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  const statePath = path.join(dir, 'state.json');
  await writeFile(configPath, JSON.stringify({ ...config, statePath }));
  return { configPath, statePath };
}

const rule = {
  id: 'orders',
  match: { fromAddresses: ['alerts@example.com'], subjectRegex: '^Novo pedido' },
  fields: {
    order: { pattern: 'Pedido[:\\s]+([A-Z0-9-]+)', flags: 'iu', required: true },
    total: { pattern: 'Total[:\\s]+([^\\n]+)', flags: 'iu', required: true },
  },
  template: 'Pedido {{order}}\nTotal: {{total}}',
} as const;

const enabled = (): GmailRelayConfig => ({
  enabled: true,
  maxMessagesPerPoll: 20,
  initialLookbackMinutes: 0,
  rules: [rule],
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('Gmail relay filters', () => {
  it('extracts fields from normalized structured email text', () => {
    expect(
      renderMatchingMessage(
        {
          id: 'm1',
          from: 'Alerts <alerts@example.com>',
          subject: 'Novo pedido recebido',
          text: 'Pedido: ABC-42\nTotal: R$ 90,00\nCliente: Joana',
          labelIds: ['INBOX'],
        },
        [rule],
      ),
    ).toEqual({ ruleId: 'orders', text: 'Pedido ABC-42\nTotal: R$ 90,00' });
  });

  it('does not match another sender or a message missing a required field', () => {
    expect(
      renderMatchingMessage({ from: 'attacker@example.net', subject: 'Novo pedido', text: 'Pedido: X\nTotal: 1' }, [
        rule,
      ]),
    ).toBeNull();
    expect(
      renderMatchingMessage({ from: 'alerts@example.com', subject: 'Novo pedido', text: 'Pedido: X' }, [rule]),
    ).toBeNull();
  });

  it('rejects an enabled rule without a positive criterion', async () => {
    const { configPath } = await files({
      enabled: true,
      rules: [{ id: 'unsafe', match: {}, template: '{{text}}' }],
    });
    await expect(pollGmailRelay(configPath)).rejects.toThrow('positive match criterion');
  });
});

describe('Gmail relay cursor safety', () => {
  it('baselines the current cursor on first run without forwarding old mail', async () => {
    const { configPath, statePath } = await files(enabled());
    const calls: string[] = [];
    const broadcast = async (): Promise<void> => {
      throw new Error('must not broadcast');
    };
    const summary = await pollGmailRelay(configPath, {
      now: () => new Date('2026-09-14T12:00:00.000Z'),
      callMcp: async (_route, tool) => {
        calls.push(tool);
        return { historyId: '100' };
      },
      broadcast,
    });
    expect(summary.status).toBe('baseline');
    expect(calls).toEqual(['get_profile']);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
      historyId: '100',
      updatedAt: '2026-09-14T12:00:00.000Z',
    });
  });

  it('reads new history, applies the filter, queues one batch, and advances the cursor', async () => {
    const { configPath, statePath } = await files(enabled());
    await writeFile(statePath, JSON.stringify({ historyId: '100', updatedAt: '2026-09-14T11:59:00.000Z' }));
    const sent: unknown[] = [];
    const summary = await pollGmailRelay(configPath, {
      now: () => new Date('2026-09-14T12:00:00.000Z'),
      callMcp: async (_route, tool, args) => {
        if (tool === 'get_profile') return { historyId: '101' };
        if (tool === 'list_history') {
          expect(args?.historyId).toBe('100');
          return { historyId: '101', history: [{ messagesAdded: [{ message: { id: 'm1' } }] }] };
        }
        if (tool === 'get_message') {
          return {
            id: 'm1',
            from: 'alerts@example.com',
            subject: 'Novo pedido recebido',
            text: 'Pedido: ABC-42\nTotal: R$ 90,00',
          };
        }
        throw new Error(`unexpected ${tool}`);
      },
      broadcast: async (messages, groupsOnly) => sent.push({ messages, groupsOnly }),
    });
    expect(summary).toMatchObject({ examined: 1, matched: 1, queued: 1, pending: 0 });
    expect(sent).toEqual([
      {
        groupsOnly: true,
        messages: [{ source_message_id: 'm1', rule_id: 'orders', text: 'Pedido ABC-42\nTotal: R$ 90,00' }],
      },
    ]);
    expect(JSON.parse(await readFile(statePath, 'utf8')).historyId).toBe('101');
  });

  it('does not advance state when the host queue rejects the batch', async () => {
    const { configPath, statePath } = await files(enabled());
    const original = { historyId: '100', updatedAt: '2026-09-14T11:59:00.000Z' };
    await writeFile(statePath, JSON.stringify(original));
    await expect(
      pollGmailRelay(configPath, {
        callMcp: async (_route, tool) => {
          if (tool === 'get_profile') return { historyId: '101' };
          if (tool === 'list_history') {
            return { historyId: '101', history: [{ messagesAdded: [{ message: { id: 'm1' } }] }] };
          }
          return {
            id: 'm1',
            from: 'alerts@example.com',
            subject: 'Novo pedido',
            text: 'Pedido: A1\nTotal: 10',
          };
        },
        broadcast: async () => {
          throw new Error('host unavailable');
        },
      }),
    ).rejects.toThrow('host unavailable');
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(original);
  });

  it('keeps the old cursor while a bounded batch still has pending messages', async () => {
    const config = enabled();
    config.maxMessagesPerPoll = 1;
    const { configPath, statePath } = await files(config);
    await writeFile(statePath, JSON.stringify({ historyId: '100', updatedAt: '2026-09-14T11:59:00.000Z' }));
    const sent: string[] = [];
    let historyCalls = 0;
    const callMcp = async (_route: string, tool: string, args?: Record<string, unknown>): Promise<any> => {
      if (tool === 'get_profile') return { historyId: '101' };
      if (tool === 'list_history') {
        historyCalls += 1;
        return {
          historyId: '101',
          history: [{ messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] }],
        };
      }
      if (tool === 'get_message') {
        return {
          id: args?.messageId,
          from: 'alerts@example.com',
          subject: 'Novo pedido',
          text: `Pedido: ${args?.messageId}\nTotal: 10`,
        };
      }
      throw new Error(`unexpected ${tool}`);
    };
    const broadcast = async (messages: Array<{ source_message_id: string }>): Promise<void> => {
      sent.push(...messages.map((message) => message.source_message_id));
    };

    expect((await pollGmailRelay(configPath, { callMcp, broadcast })).pending).toBe(1);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      historyId: '100',
      pendingMessageIds: ['m2'],
      pendingHistoryId: '101',
    });
    expect((await pollGmailRelay(configPath, { callMcp, broadcast })).pending).toBe(0);
    expect(JSON.parse(await readFile(statePath, 'utf8')).historyId).toBe('101');
    expect(historyCalls).toBe(1);
    expect(sent).toEqual(['m1', 'm2']);
  });

  it('uses a bounded search when Gmail expires the history cursor', async () => {
    const { configPath, statePath } = await files(enabled());
    await writeFile(statePath, JSON.stringify({ historyId: '1', updatedAt: '2026-09-14T11:00:00.000Z' }));
    const calls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
    await pollGmailRelay(configPath, {
      now: () => new Date('2026-09-14T12:00:00.000Z'),
      callMcp: async (_route, tool, args) => {
        calls.push({ tool, args });
        if (tool === 'get_profile') return { historyId: '200' };
        if (tool === 'list_history') return { historyExpired: true };
        if (tool === 'search_messages') return { messages: [] };
        throw new Error(`unexpected ${tool}`);
      },
      broadcast: async () => undefined,
    });
    expect(calls.find((call) => call.tool === 'search_messages')?.args?.query).toBe('after:1789383540');
    expect(JSON.parse(await readFile(statePath, 'utf8')).historyId).toBe('200');
  });
});
