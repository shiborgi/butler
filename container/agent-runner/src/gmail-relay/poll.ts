import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CONFIG_PATH = '/workspace/agent/gmail-relay.json';
const DEFAULT_STATE_PATH = '/workspace/agent/plugin-data/gmail-relay/state.json';
const MAX_HISTORY_PAGES = 20;

export interface RelayField {
  pattern: string;
  flags?: string;
  group?: number;
  required?: boolean;
}

export interface RelayRule {
  id: string;
  match: {
    fromAddresses?: string[];
    fromDomains?: string[];
    subjectRegex?: string;
    bodyRegex?: string;
    labelsAny?: string[];
    excludeSubjectRegex?: string;
    excludeBodyRegex?: string;
  };
  source?: 'text' | 'textPlain' | 'htmlText';
  fields?: Record<string, RelayField>;
  template: string;
}

export interface GmailRelayConfig {
  enabled: boolean;
  mcpRoute?: string;
  statePath?: string;
  groupsOnly?: boolean;
  maxMessagesPerPoll?: number;
  initialLookbackMinutes?: number;
  rules: RelayRule[];
}

interface RelayState {
  historyId: string;
  updatedAt: string;
  pendingMessageIds?: string[];
  pendingHistoryId?: string;
}

interface GmailMessage {
  id?: string;
  from?: string;
  subject?: string;
  date?: string;
  messageId?: string;
  labelIds?: string[];
  text?: string;
  textPlain?: string;
  htmlText?: string;
  notFound?: boolean;
}

interface PollDependencies {
  now?: () => Date;
  callMcp?: (route: string, tool: string, args?: Record<string, unknown>) => Promise<any>;
  broadcast?: (messages: BroadcastMessage[], groupsOnly: boolean) => Promise<void>;
}

interface BroadcastMessage {
  source_message_id: string;
  rule_id: string;
  text: string;
}

export interface PollSummary {
  status: 'disabled' | 'baseline' | 'polled';
  examined: number;
  matched: number;
  queued: number;
  pending: number;
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

function compile(pattern: string | undefined, label: string): RegExp | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern, 'iu');
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${error instanceof Error ? error.message : error}`);
  }
}

function validateStringArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must contain only non-empty strings`);
  }
}

function validateOptionalPattern(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
  compile(value, label);
}

function validateConfig(value: unknown): GmailRelayConfig {
  const config = asRecord(value, 'Gmail relay config');
  if (typeof config.enabled !== 'boolean') throw new Error('"enabled" must be a boolean');
  if (!Array.isArray(config.rules)) throw new Error('"rules" must be an array');
  if (config.mcpRoute !== undefined && (typeof config.mcpRoute !== 'string' || !config.mcpRoute)) {
    throw new Error('"mcpRoute" must be a non-empty string');
  }
  if (config.statePath !== undefined && (typeof config.statePath !== 'string' || !config.statePath)) {
    throw new Error('"statePath" must be a non-empty string');
  }
  if (config.groupsOnly !== undefined && typeof config.groupsOnly !== 'boolean') {
    throw new Error('"groupsOnly" must be a boolean');
  }
  const pollLimit = config.maxMessagesPerPoll;
  if (pollLimit !== undefined && (!Number.isInteger(pollLimit) || (pollLimit as number) < 1)) {
    throw new Error('"maxMessagesPerPoll" must be a positive integer');
  }
  const lookback = config.initialLookbackMinutes;
  if (lookback !== undefined && (typeof lookback !== 'number' || !Number.isFinite(lookback) || lookback < 0)) {
    throw new Error('"initialLookbackMinutes" must be a non-negative finite number');
  }
  if (config.enabled && config.rules.length === 0) {
    throw new Error('Enabled Gmail relay requires at least one fail-closed filter rule');
  }
  const ruleIds = new Set<string>();
  for (const [index, item] of config.rules.entries()) {
    const rule = asRecord(item, `rules[${index}]`) as unknown as RelayRule;
    if (typeof rule.id !== 'string' || !rule.id.trim()) throw new Error(`rules[${index}].id is required`);
    if (ruleIds.has(rule.id)) throw new Error(`rules[${index}].id must be unique`);
    ruleIds.add(rule.id);
    if (typeof rule.template !== 'string' || !rule.template.trim()) {
      throw new Error(`rules[${index}].template is required`);
    }
    if (rule.source !== undefined && !['text', 'textPlain', 'htmlText'].includes(rule.source)) {
      throw new Error(`rules[${index}].source must be text, textPlain, or htmlText`);
    }
    const match = asRecord(rule.match, `rules[${index}].match`) as RelayRule['match'];
    validateStringArray(match.fromAddresses, `rules[${index}].match.fromAddresses`);
    validateStringArray(match.fromDomains, `rules[${index}].match.fromDomains`);
    validateStringArray(match.labelsAny, `rules[${index}].match.labelsAny`);
    const positive =
      (Array.isArray(match.fromAddresses) && match.fromAddresses.length > 0) ||
      (Array.isArray(match.fromDomains) && match.fromDomains.length > 0) ||
      Boolean(match.subjectRegex) ||
      Boolean(match.bodyRegex) ||
      (Array.isArray(match.labelsAny) && match.labelsAny.length > 0);
    if (!positive) throw new Error(`rules[${index}] needs at least one positive match criterion`);
    for (const [name, pattern] of [
      ['subjectRegex', match.subjectRegex],
      ['bodyRegex', match.bodyRegex],
      ['excludeSubjectRegex', match.excludeSubjectRegex],
      ['excludeBodyRegex', match.excludeBodyRegex],
    ] as const) {
      validateOptionalPattern(pattern, `rules[${index}].match.${name}`);
    }
    for (const [name, rawField] of Object.entries(rule.fields ?? {})) {
      const field = asRecord(rawField, `rules[${index}].fields.${name}`) as unknown as RelayField;
      if (typeof field.pattern !== 'string' || !field.pattern) {
        throw new Error(`rules[${index}].fields.${name}.pattern is required`);
      }
      if (field.flags !== undefined && typeof field.flags !== 'string') {
        throw new Error(`rules[${index}].fields.${name}.flags must be a string`);
      }
      if (field.group !== undefined && (!Number.isInteger(field.group) || field.group < 0)) {
        throw new Error(`rules[${index}].fields.${name}.group must be a non-negative integer`);
      }
      if (field.required !== undefined && typeof field.required !== 'boolean') {
        throw new Error(`rules[${index}].fields.${name}.required must be a boolean`);
      }
      try {
        new RegExp(field.pattern, field.flags ?? 'iu');
      } catch (error) {
        throw new Error(
          `rules[${index}].fields.${name}.pattern is invalid: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  return config as unknown as GmailRelayConfig;
}

function senderAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

function sourceText(message: GmailMessage, rule: RelayRule): string {
  const preferred = rule.source ?? 'text';
  return String(message[preferred] ?? message.text ?? message.textPlain ?? message.htmlText ?? '');
}

/** Match and render one normalized Gmail message. First valid rule wins. */
export function renderMatchingMessage(
  message: GmailMessage,
  rules: readonly RelayRule[],
): { ruleId: string; text: string } | null {
  const subject = message.subject ?? '';
  const address = senderAddress(message.from ?? '');
  const domain = address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : '';
  const labels = new Set(message.labelIds ?? []);

  for (const rule of rules) {
    const body = sourceText(message, rule);
    const match = rule.match;
    const senders = [
      ...(match.fromAddresses ?? []).map((value) => value.trim().toLowerCase()),
      ...(match.fromDomains ?? []).map((value) => `@${value.trim().replace(/^@/, '').toLowerCase()}`),
    ];
    if (
      senders.length > 0 &&
      !senders.some((value) => (value.startsWith('@') ? `@${domain}` === value : address === value))
    ) {
      continue;
    }
    if (match.subjectRegex && !compile(match.subjectRegex, `${rule.id}.subjectRegex`)!.test(subject)) continue;
    if (match.bodyRegex && !compile(match.bodyRegex, `${rule.id}.bodyRegex`)!.test(body)) continue;
    if (match.labelsAny?.length && !match.labelsAny.some((label) => labels.has(label))) continue;
    if (
      match.excludeSubjectRegex &&
      compile(match.excludeSubjectRegex, `${rule.id}.excludeSubjectRegex`)!.test(subject)
    ) {
      continue;
    }
    if (match.excludeBodyRegex && compile(match.excludeBodyRegex, `${rule.id}.excludeBodyRegex`)!.test(body)) continue;

    const values: Record<string, string> = {
      text: body,
      subject,
      from: message.from ?? '',
      date: message.date ?? '',
      messageId: message.messageId ?? message.id ?? '',
    };
    let missingRequired = false;
    for (const [name, field] of Object.entries(rule.fields ?? {})) {
      const result = new RegExp(field.pattern, field.flags ?? 'iu').exec(body);
      const value = result?.[field.group ?? 1]?.trim() ?? '';
      if (field.required && !value) missingRequired = true;
      values[name] = value;
    }
    if (missingRequired) continue;
    // JSON authors commonly write "\\n" intending a chat line break. Normalize
    // the template before interpolation so message values remain untouched.
    const template = rule.template.replace(/\\n/g, '\n');
    const rendered = template.replace(
      /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
      (_token, key: string) => values[key] ?? '',
    );
    const text = rendered.trim().slice(0, 16_000);
    if (text) return { ruleId: rule.id, text };
  }
  return null;
}

async function defaultCallMcp(route: string, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const base = process.env.NANOCLAW_GATEWAY_URL?.replace(/\/+$/, '');
  const bearer = process.env.OPENAI_API_KEY;
  if (!base || !bearer) throw new Error('NANOCLAW_GATEWAY_URL and OPENAI_API_KEY are required');
  const response = await fetch(`${base}/mcp/${encodeURIComponent(route)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${Date.now()}-${tool}`,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  if (!response.ok) throw new Error(`Gateway ${tool} failed with HTTP ${response.status}`);
  const rpc = (await response.json()) as any;
  if (rpc.error) throw new Error(`Gateway ${tool} failed: ${rpc.error.message ?? 'JSON-RPC error'}`);
  if (rpc.result?.isError) throw new Error(`Gmail ${tool} failed: ${rpc.result.content?.[0]?.text ?? 'tool error'}`);
  const text = rpc.result?.content?.find((item: any) => item?.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`Gmail ${tool} returned no text result`);
  return JSON.parse(text);
}

async function sendBroadcastBatch(messages: BroadcastMessage[], groupsOnly: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // `gmail-relay-broadcast` is a hidden single-token host command. Keeping
    // it as one argument is important: the container CLI bridge dispatches
    // registered command names, rather than implementing nested subcommands.
    const child = spawn('ncl', ['gmail-relay-broadcast', '--stdin-json', '--json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ncl relay failed (${code}): ${stderr.trim().slice(0, 500)}`));
      try {
        const response = JSON.parse(stdout) as { ok?: boolean; error?: { message?: string } };
        if (!response.ok) return reject(new Error(response.error?.message ?? 'ncl relay rejected the batch'));
        resolve();
      } catch (error) {
        reject(new Error(`ncl relay returned invalid JSON: ${error instanceof Error ? error.message : error}`));
      }
    });
    child.stdin.end(JSON.stringify({ messages, groups_only: groupsOnly }));
  });
}

async function defaultBroadcast(messages: BroadcastMessage[], groupsOnly: boolean): Promise<void> {
  let batch: BroadcastMessage[] = [];
  for (const message of messages) {
    const candidate = [...batch, message];
    if (Buffer.byteLength(JSON.stringify({ messages: candidate, groups_only: groupsOnly })) > 60_000) {
      if (batch.length === 0)
        throw new Error(`Rendered Gmail message ${message.source_message_id} exceeds ncl input limit`);
      await sendBroadcastBatch(batch, groupsOnly);
      batch = [message];
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) await sendBroadcastBatch(batch, groupsOnly);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readState(file: string): Promise<RelayState | null> {
  try {
    const raw = asRecord(await readJson(file), 'Gmail relay state');
    if (
      typeof raw.historyId !== 'string' ||
      typeof raw.updatedAt !== 'string' ||
      !Number.isFinite(new Date(raw.updatedAt).getTime()) ||
      (raw.pendingHistoryId !== undefined && typeof raw.pendingHistoryId !== 'string') ||
      (raw.pendingMessageIds !== undefined &&
        (!Array.isArray(raw.pendingMessageIds) || raw.pendingMessageIds.some((id) => typeof id !== 'string')))
    )
      throw new Error('state cursor is invalid');
    return raw as unknown as RelayState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeState(file: string, state: RelayState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

async function collectHistory(
  route: string,
  historyId: string,
  callMcp: NonNullable<PollDependencies['callMcp']>,
): Promise<{ expired: boolean; ids: string[]; targetHistoryId?: string }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let targetHistoryId: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const result = await callMcp(route, 'list_history', { historyId, maxResults: 500, pageToken });
    if (result.historyExpired) return { expired: true, ids: [] };
    for (const record of result.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        if (typeof added.message?.id === 'string') ids.push(added.message.id);
      }
    }
    if (typeof result.historyId === 'string') targetHistoryId = result.historyId;
    pageToken = typeof result.nextPageToken === 'string' ? result.nextPageToken : undefined;
    if (!pageToken) return { expired: false, ids: [...new Set(ids)], targetHistoryId };
  }
  throw new Error(`Gmail history exceeded ${MAX_HISTORY_PAGES} pages; refusing to advance the cursor`);
}

async function collectSearch(
  route: string,
  after: Date,
  callMcp: NonNullable<PollDependencies['callMcp']>,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const result = await callMcp(route, 'search_messages', {
      query: `after:${Math.floor(after.getTime() / 1000)}`,
      maxResults: 500,
      pageToken,
    });
    for (const message of result.messages ?? []) if (typeof message.id === 'string') ids.push(message.id);
    pageToken = typeof result.nextPageToken === 'string' ? result.nextPageToken : undefined;
    if (!pageToken) return [...new Set(ids)];
  }
  throw new Error(`Gmail recovery search exceeded ${MAX_HISTORY_PAGES} pages; refusing to advance the cursor`);
}

async function processPending(
  config: GmailRelayConfig,
  state: RelayState,
  route: string,
  callMcp: NonNullable<PollDependencies['callMcp']>,
  broadcast: NonNullable<PollDependencies['broadcast']>,
  now: Date,
): Promise<PollSummary> {
  const limit = Math.min(config.maxMessagesPerPoll ?? 10, 100);
  const pending = [...(state.pendingMessageIds ?? [])];
  const batch = pending.slice(0, limit);
  const outbound: BroadcastMessage[] = [];
  let examined = 0;
  for (const id of batch) {
    const message = (await callMcp(route, 'get_message', { messageId: id })) as GmailMessage;
    examined += 1;
    if (message.notFound) continue;
    const rendered = renderMatchingMessage(message, config.rules);
    if (rendered) outbound.push({ source_message_id: id, rule_id: rendered.ruleId, text: rendered.text });
  }
  if (outbound.length > 0) await broadcast(outbound, config.groupsOnly !== false);

  const remaining = pending.slice(batch.length);
  if (remaining.length > 0) state.pendingMessageIds = remaining;
  else {
    state.historyId = state.pendingHistoryId ?? state.historyId;
    delete state.pendingMessageIds;
    delete state.pendingHistoryId;
  }
  state.updatedAt = now.toISOString();
  return { status: 'polled', examined, matched: outbound.length, queued: outbound.length, pending: remaining.length };
}

/** Poll once. It never wakes the language model; errors are surfaced to the task backoff. */
export async function pollGmailRelay(
  configPath = DEFAULT_CONFIG_PATH,
  deps: PollDependencies = {},
): Promise<PollSummary> {
  const config = validateConfig(await readJson(configPath));
  if (!config.enabled) return { status: 'disabled', examined: 0, matched: 0, queued: 0, pending: 0 };

  const callMcp = deps.callMcp ?? defaultCallMcp;
  const broadcast = deps.broadcast ?? defaultBroadcast;
  const now = (deps.now ?? (() => new Date()))();
  const route = config.mcpRoute ?? 'google-gmail';
  const statePath = config.statePath ?? DEFAULT_STATE_PATH;
  const profile = await callMcp(route, 'get_profile');
  if (typeof profile.historyId !== 'string') throw new Error('Gmail profile returned no historyId');
  let state = await readState(statePath);

  if (!state) {
    state = { historyId: profile.historyId, updatedAt: now.toISOString() };
    const lookback = Math.max(config.initialLookbackMinutes ?? 0, 0);
    if (lookback === 0) {
      await writeState(statePath, state);
      return { status: 'baseline', examined: 0, matched: 0, queued: 0, pending: 0 };
    }
    state.pendingMessageIds = await collectSearch(route, new Date(now.getTime() - lookback * 60_000), callMcp);
    state.pendingHistoryId = profile.historyId;
  }

  if (!state.pendingMessageIds?.length) {
    const history = await collectHistory(route, state.historyId, callMcp);
    if (history.expired) {
      state.pendingMessageIds = await collectSearch(
        route,
        new Date(Math.max(0, new Date(state.updatedAt).getTime() - 60_000)),
        callMcp,
      );
      state.pendingHistoryId = profile.historyId;
    } else {
      state.pendingMessageIds = history.ids;
      state.pendingHistoryId = history.targetHistoryId ?? state.historyId;
    }
    if (state.pendingMessageIds.length === 0) {
      state.historyId = state.pendingHistoryId ?? state.historyId;
      delete state.pendingMessageIds;
      delete state.pendingHistoryId;
      state.updatedAt = now.toISOString();
      await writeState(statePath, state);
      return { status: 'polled', examined: 0, matched: 0, queued: 0, pending: 0 };
    }
  }

  const summary = await processPending(config, state, route, callMcp, broadcast, now);
  await writeState(statePath, state);
  return summary;
}

if (import.meta.main) {
  pollGmailRelay(process.argv[2] ?? DEFAULT_CONFIG_PATH)
    .then((summary) => process.stdout.write(`${JSON.stringify({ wakeAgent: false, data: summary })}\n`))
    .catch((error) => {
      process.stderr.write(`[gmail-relay] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
