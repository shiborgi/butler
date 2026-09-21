import { getDb } from '../../db/connection.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { register } from '../../cli/registry.js';
import type { CallerContext } from '../../cli/frame.js';
import './migration.js';
import { drainGmailRelayDeliveries, enqueueGmailRelay, recoverStaleGmailRelayDeliveries } from './queue.js';

interface RelayArgs {
  group?: string;
  groupsOnly: boolean;
  messages: Array<{ sourceMessageId: string; text: string; ruleId?: string }>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`"${field}" must be a string`);
  return value;
}

function parseRelayArgs(raw: Record<string, unknown>): RelayArgs {
  if (!Array.isArray(raw.messages) || raw.messages.length === 0 || raw.messages.length > 100) {
    throw new Error('"messages" must contain between 1 and 100 items');
  }
  const messages = raw.messages.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`messages[${index}] must be an object`);
    }
    const value = item as Record<string, unknown>;
    const sourceMessageId = value.source_message_id ?? value.sourceMessageId;
    if (typeof sourceMessageId !== 'string' || !sourceMessageId.trim() || sourceMessageId.length > 512) {
      throw new Error(`messages[${index}].source_message_id must be a non-empty string`);
    }
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16_000) {
      throw new Error(`messages[${index}].text must contain 1 to 16000 characters`);
    }
    return {
      sourceMessageId: sourceMessageId.trim(),
      text: value.text.trim(),
      ruleId: (() => {
        const ruleId = optionalString(value.rule_id ?? value.ruleId, `messages[${index}].rule_id`);
        if (ruleId && ruleId.length > 256) throw new Error(`messages[${index}].rule_id is too long`);
        return ruleId;
      })(),
    };
  });
  const groupsOnly = raw.groups_only ?? raw.groupsOnly;
  if (groupsOnly !== undefined && typeof groupsOnly !== 'boolean') {
    throw new Error('"groups_only" must be a boolean');
  }
  return {
    group: optionalString(raw.group, 'group'),
    groupsOnly: groupsOnly !== false,
    messages,
  };
}

function callerGroup(args: RelayArgs, ctx: CallerContext): string {
  if (ctx.caller === 'agent') {
    if (args.group && args.group !== ctx.agentGroupId) {
      throw new Error('Gmail relay may only target the caller agent group');
    }
    return ctx.agentGroupId;
  }
  if (!args.group) throw new Error('"group" is required for a host caller');
  return args.group;
}

register({
  name: 'gmail-relay-broadcast',
  description: 'Queue filtered Gmail text for the caller agent group WhatsApp rooms.',
  access: 'hidden',
  parseArgs: parseRelayArgs,
  handler: async (args, ctx) => {
    const result = await enqueueGmailRelay(callerGroup(args, ctx), args.messages, args.groupsOnly);
    void drainGmailRelayDeliveries().catch((err) => log.error('Gmail relay drain failed', { err }));
    return result;
  },
});

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function scheduleDrain(delayMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void recoverStaleGmailRelayDeliveries(getDb())
      .then(() => drainGmailRelayDeliveries())
      .catch((err) => log.error('Gmail relay background drain failed', { err }))
      .finally(() => scheduleDrain(5_000));
  }, delayMs);
  timer.unref?.();
}

onHostStart(async () => {
  stopped = false;
  await recoverStaleGmailRelayDeliveries(getDb());
  scheduleDrain(0);
});

onHostShutdown(() => {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
});

export { drainGmailRelayDeliveries, enqueueGmailRelay } from './queue.js';
