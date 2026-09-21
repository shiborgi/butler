/**
 * Read-only Gmail tools for the gateway's built-in Google MCP server.
 *
 * Gmail returns message bodies as a recursive MIME tree with base64url data.
 * That transport shape is useful to an email client but hostile to an agent,
 * so this adapter returns headers and normalized text while deliberately
 * omitting raw HTML and attachment bytes.
 */
import { GoogleApiError, type Fetcher } from './google-api.js';
import type { ToolDefinition } from './google-tools.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 100_000;

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  historyId?: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' && args[key] ? (args[key] as string) : undefined;

const num = (args: Record<string, unknown>, key: string): number | undefined =>
  typeof args[key] === 'number' ? (args[key] as number) : undefined;

const bool = (args: Record<string, unknown>, key: string): boolean | undefined =>
  typeof args[key] === 'boolean' ? (args[key] as boolean) : undefined;

function required(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (!value) throw new Error(`"${key}" is required`);
  return value;
}

/** Tools intentionally stop at reading: gmail.readonly grants no mutation. */
export const GMAIL_TOOLS: ToolDefinition[] = [
  {
    name: 'get_profile',
    description: 'Get the connected Gmail address, message totals, and current history cursor.',
    inputSchema: { type: 'object', properties: {} },
    request: () => ({ method: 'GET', url: `${GMAIL_API}/profile` }),
  },
  {
    name: 'list_labels',
    description: 'List system and user labels in the connected Gmail mailbox.',
    inputSchema: { type: 'object', properties: {} },
    request: () => ({ method: 'GET', url: `${GMAIL_API}/labels` }),
  },
  {
    name: 'search_messages',
    description:
      'Search messages using Gmail search syntax, e.g. `from:alerts@example.com is:unread`. ' +
      'Results contain ids; call get_message to read a result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query' },
        labelId: { type: 'string', description: 'Optional label id that every result must have' },
        maxResults: { type: 'number', description: 'Max results, 1-500 (default 25)' },
        pageToken: { type: 'string', description: 'Continuation token from a previous call' },
        includeSpamTrash: { type: 'boolean', description: 'Include SPAM and TRASH (default false)' },
      },
    },
    request: (args) => ({
      method: 'GET',
      url: `${GMAIL_API}/messages`,
      query: {
        q: str(args, 'query'),
        labelIds: str(args, 'labelId'),
        maxResults: Math.min(Math.max(num(args, 'maxResults') ?? 25, 1), 500),
        pageToken: str(args, 'pageToken'),
        includeSpamTrash: bool(args, 'includeSpamTrash') ?? false,
      },
    }),
  },
  {
    name: 'get_message',
    description:
      'Read one Gmail message by id. Returns common headers plus normalized plain text; raw HTML and attachments are omitted.',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string', description: 'Gmail message id' } },
      required: ['messageId'],
    },
    request: (args) => ({
      method: 'GET',
      url: `${GMAIL_API}/messages/${encodeURIComponent(required(args, 'messageId'))}`,
      query: { format: 'full' },
    }),
  },
  {
    name: 'get_thread',
    description:
      'Read every message in a Gmail thread. Each message is returned with common headers and normalized plain text.',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string', description: 'Gmail thread id' } },
      required: ['threadId'],
    },
    request: (args) => ({
      method: 'GET',
      url: `${GMAIL_API}/threads/${encodeURIComponent(required(args, 'threadId'))}`,
      query: { format: 'full' },
    }),
  },
  {
    name: 'list_history',
    description:
      'List messages added since a Gmail history cursor. A stale cursor returns historyExpired=true; resync with search_messages.',
    inputSchema: {
      type: 'object',
      properties: {
        historyId: { type: 'string', description: 'Cursor returned by get_profile or an earlier history response' },
        labelId: { type: 'string', description: 'Only include changes associated with this label id' },
        maxResults: { type: 'number', description: 'Max history records, 1-500 (default 100)' },
        pageToken: { type: 'string', description: 'Continuation token from a previous call' },
      },
      required: ['historyId'],
    },
    request: (args) => ({
      method: 'GET',
      url: `${GMAIL_API}/history`,
      query: {
        startHistoryId: required(args, 'historyId'),
        historyTypes: 'messageAdded',
        labelId: str(args, 'labelId'),
        maxResults: Math.min(Math.max(num(args, 'maxResults') ?? 100, 1), 500),
        pageToken: str(args, 'pageToken'),
      },
    }),
  },
];

function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value;
}

function decodePart(data: string, contentType: string | undefined): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const bytes = Buffer.from(padded, 'base64');
  const charset = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  const codePoint = (entity: string, radix: number): string => {
    const value = Number.parseInt(entity, radix);
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '\ufffd';
  };
  return value
    .replace(/&#(\d+);/g, (_match, decimal: string) => codePoint(decimal, 10))
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => codePoint(hex, 16))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity);
}

/** Preserve useful table/paragraph boundaries while stripping executable markup. */
export function htmlToText(html: string): string {
  const withoutUnsafe = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const withBoundaries = withoutUnsafe
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, '\t')
    .replace(/<(td|th)\b[^>]*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  return normalizeText(decodeEntities(withBoundaries));
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/[\t ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

function collectBodies(part: GmailPart | undefined, plain: string[], html: string[]): void {
  if (!part) return;
  const disposition = headerValue(part.headers, 'content-disposition') ?? '';
  const isAttachment = Boolean(part.filename) || /\battachment\b/i.test(disposition);
  const data = part.body?.data;
  const mimeType = part.mimeType?.toLowerCase();
  if (!isAttachment && data && (mimeType === 'text/plain' || mimeType === 'text/html')) {
    const decoded = decodePart(data, headerValue(part.headers, 'content-type'));
    if (mimeType === 'text/plain') plain.push(normalizeText(decoded));
    else html.push(htmlToText(decoded));
  }
  for (const child of part.parts ?? []) collectBodies(child, plain, html);
}

/** Convert Google's recursive Message resource into a stable, agent-safe view. */
export function normalizeGmailMessage(message: GmailMessage): Record<string, unknown> {
  const plain: string[] = [];
  const html: string[] = [];
  collectBodies(message.payload, plain, html);
  const textPlain = normalizeText(plain.filter(Boolean).join('\n\n'));
  const htmlText = normalizeText(html.filter(Boolean).join('\n\n'));
  const headers = message.payload?.headers;
  return {
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId,
    internalDate: message.internalDate,
    labelIds: message.labelIds ?? [],
    from: headerValue(headers, 'from'),
    to: headerValue(headers, 'to'),
    cc: headerValue(headers, 'cc'),
    subject: headerValue(headers, 'subject'),
    date: headerValue(headers, 'date'),
    messageId: headerValue(headers, 'message-id'),
    snippet: message.snippet,
    text: textPlain || htmlText || message.snippet || '',
    textPlain: textPlain || undefined,
    htmlText: htmlText || undefined,
  };
}

/** Dispatch the Gmail operations that need response normalization. */
export async function handleGmailTool(
  accessToken: string,
  toolName: string,
  args: Record<string, unknown>,
  definition: ToolDefinition,
  fetcher: Fetcher,
): Promise<unknown> {
  try {
    const response = await fetcher(accessToken, definition.request(args));
    if (toolName === 'get_message') return normalizeGmailMessage(response as GmailMessage);
    if (toolName === 'get_thread') {
      const thread = response as { id?: string; historyId?: string; messages?: GmailMessage[] };
      return {
        id: thread.id,
        historyId: thread.historyId,
        messages: (thread.messages ?? []).map(normalizeGmailMessage),
      };
    }
    return response;
  } catch (error) {
    if (toolName === 'list_history' && error instanceof GoogleApiError && error.status === 404) {
      return { historyExpired: true };
    }
    // A message can be deleted between list_history and get_message. Treat
    // that ordinary race as a consumed tombstone so a poller does not retry
    // the same missing id forever and block every newer message behind it.
    if (toolName === 'get_message' && error instanceof GoogleApiError && error.status === 404) {
      return { id: str(args, 'messageId'), notFound: true };
    }
    throw error;
  }
}
