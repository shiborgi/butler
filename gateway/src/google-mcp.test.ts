/**
 * The built-in Google servers, driven through the same entry the gateway uses.
 *
 * What matters here is not that a request object is well formed — it is that
 * the shape an agent is told to send produces the call Google actually wants.
 * The failures these guard are the ones an agent cannot diagnose: an all-day
 * event sent as a date-time, a native Doc read as raw bytes, a tool error
 * delivered as a transport error the model never sees.
 */
import { describe, expect, it } from 'bun:test';

import { callGoogle, GoogleApiError, type Fetcher, type GoogleRequest } from './google-api.js';
import { handleBuiltinMcp } from './google-mcp.js';
import { BUILTIN_TOOLS } from './google-tools.js';

const token = async (): Promise<string> => 'test-access-token';

/** Records every call and returns a canned body per call index. */
function recorder(bodies: unknown[] = [{}]): { calls: GoogleRequest[]; tokens: string[]; fetcher: Fetcher } {
  const calls: GoogleRequest[] = [];
  const tokens: string[] = [];
  const fetcher: Fetcher = async (accessToken, request) => {
    tokens.push(accessToken);
    calls.push(request);
    return bodies[calls.length - 1] ?? {};
  };
  return { calls, tokens, fetcher };
}

const gmailData = (value: string): string => Buffer.from(value).toString('base64url');

function toolBody(response: any): any {
  return JSON.parse(response.result.content[0].text);
}

async function call(server: string, name: string, args: Record<string, unknown>, fetcher: Fetcher): Promise<any> {
  return handleBuiltinMcp(
    server,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accessToken: token, fetcher },
  );
}

describe('protocol surface', () => {
  it('answers initialize with the server name', async () => {
    const res: any = await handleBuiltinMcp('google-tasks', { id: 1, method: 'initialize' }, { accessToken: token });
    expect(res.result.serverInfo.name).toBe('google-tasks');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('lists every tool with a schema', async () => {
    for (const [server, tools] of Object.entries(BUILTIN_TOOLS)) {
      const res: any = await handleBuiltinMcp(server, { id: 1, method: 'tools/list' }, { accessToken: token });
      expect(res.result.tools).toHaveLength(tools.length);
      for (const tool of res.result.tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema.type).toBe('object');
      }
    }
  });

  it('returns nothing for a notification, so the caller can send 202', async () => {
    const res = await handleBuiltinMcp(
      'google-drive',
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { accessToken: token },
    );
    expect(res).toBeNull();
  });

  it('rejects an unknown server and an unsupported method', async () => {
    const bad: any = await handleBuiltinMcp('google-photos', { id: 1, method: 'initialize' }, { accessToken: token });
    expect(bad.error.code).toBe(-32601);
    const method: any = await handleBuiltinMcp('google-drive', { id: 2, method: 'resources/list' }, { accessToken: token });
    expect(method.error.code).toBe(-32601);
  });
});

describe('calendar', () => {
  /*
   * Calendar takes `date` for all-day and `dateTime` for timed events and
   * rejects the wrong key. The agent only ever signals which it means by the
   * shape of the string it passes, so this mapping is the whole contract.
   */
  it('sends a bare date as an all-day event and a timestamp as a timed one', async () => {
    const { calls, fetcher } = recorder();
    await call('google-calendar', 'create_event', { summary: 'Holiday', start: '2026-09-10', end: '2026-09-11' }, fetcher);
    expect((calls[0]!.body as any).start).toEqual({ date: '2026-09-10' });

    const timed = recorder();
    await call(
      'google-calendar',
      'create_event',
      { summary: 'Standup', start: '2026-09-10T09:00:00Z', end: '2026-09-10T09:15:00Z' },
      timed.fetcher,
    );
    expect((timed.calls[0]!.body as any).start).toEqual({ dateTime: '2026-09-10T09:00:00Z' });
  });

  it('expands attendee emails into the objects the API expects', async () => {
    const { calls, fetcher } = recorder();
    await call(
      'google-calendar',
      'create_event',
      { summary: 'Review', start: '2026-09-10T09:00:00Z', end: '2026-09-10T10:00:00Z', attendees: ['a@x.test', 'b@x.test'] },
      fetcher,
    );
    expect((calls[0]!.body as any).attendees).toEqual([{ email: 'a@x.test' }, { email: 'b@x.test' }]);
  });

  it('defaults to the primary calendar and expands recurrences in order', async () => {
    const { calls, fetcher } = recorder();
    await call('google-calendar', 'list_events', {}, fetcher);
    expect(calls[0]!.url).toContain('/calendars/primary/events');
    expect(calls[0]!.query).toMatchObject({ singleEvents: true, orderBy: 'startTime' });
  });

  it('sends only the fields an update names', async () => {
    const { calls, fetcher } = recorder();
    await call('google-calendar', 'update_event', { eventId: 'e1', summary: 'Renamed' }, fetcher);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ summary: 'Renamed' });
  });
});

describe('drive', () => {
  /*
   * A Google-native doc has no bytes to download: alt=media returns 403 and
   * the agent is told "permission", which sends it looking in the wrong place.
   * Resolving the type first is what turns that into a working read.
   */
  it('exports a native Doc as text instead of downloading it', async () => {
    const { calls, fetcher } = recorder([
      { id: 'f1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
      'the body',
    ]);
    const res: any = await call('google-drive', 'read_file_content', { fileId: 'f1' }, fetcher);
    expect(calls[1]!.url).toContain('/export');
    expect(calls[1]!.query).toMatchObject({ mimeType: 'text/plain' });
    expect(res.result.isError).toBeUndefined();
  });

  it('exports a native Sheet as CSV, where text/plain would lose the columns', async () => {
    const { calls, fetcher } = recorder([{ id: 'f2', mimeType: 'application/vnd.google-apps.spreadsheet' }, 'a,b']);
    await call('google-drive', 'read_file_content', { fileId: 'f2' }, fetcher);
    expect(calls[1]!.query).toMatchObject({ mimeType: 'text/csv' });
  });

  it('downloads a non-native file as media', async () => {
    const { calls, fetcher } = recorder([{ id: 'f3', mimeType: 'text/plain' }, 'plain body']);
    await call('google-drive', 'read_file_content', { fileId: 'f3' }, fetcher);
    expect(calls[1]!.query).toMatchObject({ alt: 'media' });
    expect(calls[1]!.url).not.toContain('/export');
  });

  it('creates a file as metadata then bytes', async () => {
    const { calls, fetcher } = recorder([{ id: 'new1' }, { id: 'new1', name: 'a.txt' }]);
    await call('google-drive', 'create_file', { name: 'a.txt', content: 'hello' }, fetcher);
    expect(calls[0]!.method).toBe('POST');
    expect((calls[0]!.body as any).name).toBe('a.txt');
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.query).toMatchObject({ uploadType: 'media' });
    expect(calls[1]!.body).toBe('hello');
  });

  it('caps an oversized pageSize rather than letting Google reject it', async () => {
    const { calls, fetcher } = recorder();
    await call('google-drive', 'search_files', { query: "name contains 'x'", pageSize: 5000 }, fetcher);
    expect(calls[0]!.query!.pageSize).toBe(100);
  });
});

describe('gmail', () => {
  it('maps Gmail search syntax, paging, and the read-only spam option', async () => {
    const { calls, fetcher } = recorder([{ messages: [] }]);
    await call(
      'google-gmail',
      'search_messages',
      {
        query: 'from:alerts@example.com is:unread',
        labelId: 'INBOX',
        maxResults: 900,
        includeSpamTrash: true,
        pageToken: 'next-page',
      },
      fetcher,
    );
    expect(calls[0]).toEqual({
      method: 'GET',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages',
      query: {
        q: 'from:alerts@example.com is:unread',
        labelIds: 'INBOX',
        maxResults: 500,
        pageToken: 'next-page',
        includeSpamTrash: true,
      },
    });
  });

  it('decodes a structured HTML email into text without exposing markup', async () => {
    const { calls, fetcher } = recorder([
      {
        id: 'm1',
        threadId: 't1',
        historyId: '101',
        labelIds: ['INBOX', 'UNREAD'],
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: 'Alerts <alerts@example.com>' },
            { name: 'Subject', value: 'Pedido aprovado' },
          ],
          parts: [
            {
              mimeType: 'text/html',
              headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }],
              body: {
                data: gmailData(
                  '<html><head><style>.x{color:red}</style></head><body><table><tr><th>Pedido</th><th>Total</th></tr><tr><td>ABC-42</td><td>R$ 90 &amp; frete</td></tr></table><script>steal()</script></body></html>',
                ),
              },
            },
          ],
        },
      },
    ]);

    const response = await call('google-gmail', 'get_message', { messageId: 'm1' }, fetcher);
    const body = toolBody(response);
    expect(calls[0]!.query).toEqual({ format: 'full' });
    expect(body).toMatchObject({
      id: 'm1',
      threadId: 't1',
      from: 'Alerts <alerts@example.com>',
      subject: 'Pedido aprovado',
      labelIds: ['INBOX', 'UNREAD'],
    });
    expect(body.text).toContain('Pedido\tTotal');
    expect(body.text).toContain('ABC-42\tR$ 90 & frete');
    expect(body.text).not.toContain('<table>');
    expect(body.text).not.toContain('steal()');
  });

  it('prefers a plain-text alternative and omits attachment contents', async () => {
    const { fetcher } = recorder([
      {
        id: 'm2',
        snippet: 'fallback',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/plain', body: { data: gmailData('Readable body') } },
            {
              mimeType: 'text/plain',
              filename: 'secret.txt',
              body: { data: gmailData('Attachment contents') },
            },
            { mimeType: 'text/html', body: { data: gmailData('<b>HTML body</b>') } },
          ],
        },
      },
    ]);
    const body = toolBody(await call('google-gmail', 'get_message', { messageId: 'm2' }, fetcher));
    expect(body.text).toBe('Readable body');
    expect(body.htmlText).toBe('HTML body');
    expect(JSON.stringify(body)).not.toContain('Attachment contents');
  });

  it('normalizes every message in a thread', async () => {
    const { fetcher } = recorder([
      {
        id: 't1',
        historyId: '103',
        messages: [
          { id: 'm1', payload: { mimeType: 'text/plain', body: { data: gmailData('First') } } },
          { id: 'm2', payload: { mimeType: 'text/html', body: { data: gmailData('<p>Second</p>') } } },
        ],
      },
    ]);
    const body = toolBody(await call('google-gmail', 'get_thread', { threadId: 't1' }, fetcher));
    expect(body.messages.map((message: any) => message.text)).toEqual(['First', 'Second']);
  });

  it('marks an expired history cursor so a caller can perform a bounded resync', async () => {
    const failing: Fetcher = async () => {
      throw new GoogleApiError('HistoryId is too old', 404);
    };
    const response = await call('google-gmail', 'list_history', { historyId: '10' }, failing);
    expect(toolBody(response)).toEqual({ historyExpired: true });
    expect(response.result.isError).toBeUndefined();
  });

  it('marks a deleted history message as a consumed tombstone', async () => {
    const failing: Fetcher = async () => {
      throw new GoogleApiError('Message not found', 404);
    };
    const response = await call('google-gmail', 'get_message', { messageId: 'deleted-1' }, failing);
    expect(toolBody(response)).toEqual({ id: 'deleted-1', notFound: true });
    expect(response.result.isError).toBeUndefined();
  });
});

describe('tasks', () => {
  it('uses the default list and hides completed tasks unless asked', async () => {
    const { calls, fetcher } = recorder();
    await call('google-tasks', 'list_tasks', {}, fetcher);
    expect(calls[0]!.url).toContain('/lists/%40default/tasks');
    expect(calls[0]!.query).toMatchObject({ showCompleted: false });

    const shown = recorder();
    await call('google-tasks', 'list_tasks', { showCompleted: true }, shown.fetcher);
    expect(shown.calls[0]!.query).toMatchObject({ showCompleted: true, showHidden: true });
  });

  it('completes a task through status rather than a separate verb', async () => {
    const { calls, fetcher } = recorder();
    await call('google-tasks', 'update_task', { taskId: 't1', status: 'completed' }, fetcher);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ status: 'completed' });
  });
});

describe('failures reach the model as tool results', () => {
  it('reports a missing required argument without calling Google', async () => {
    const { calls, fetcher } = recorder();
    const res: any = await call('google-calendar', 'get_event', {}, fetcher);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('"eventId" is required');
    expect(calls).toHaveLength(0);
  });

  it('passes a Google error message through instead of a transport failure', async () => {
    const failing: Fetcher = async () => {
      throw new GoogleApiError('Calendar usage limits exceeded', 403);
    };
    const res: any = await call('google-calendar', 'list_calendars', {}, failing);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe('Calendar usage limits exceeded');
    expect(res.error).toBeUndefined();
  });

  it('names an unknown tool rather than silently doing nothing', async () => {
    const { fetcher } = recorder();
    const res: any = await call('google-tasks', 'delete_everything', {}, fetcher);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('delete_everything');
  });
});

describe('the access token', () => {
  it('is fetched per call and reaches every request', async () => {
    const { tokens, fetcher } = recorder([{ id: 'f1', mimeType: 'text/plain' }, 'body']);
    await call('google-drive', 'read_file_content', { fileId: 'f1' }, fetcher);
    expect(tokens).toEqual(['test-access-token', 'test-access-token']);
  });
});

/*
 * `callGoogle` is the one place a real HTTP body is interpreted, and Drive is
 * the API that returns something other than JSON on success: `alt=media` and
 * `/export` return the file. Parsing those as JSON turned every read of a CSV
 * or a plain-text note into "non-JSON success body" — a failure whose message
 * pointed at the transport rather than at the caller's own request.
 */
describe('callGoogle body handling', () => {
  const withFetch = async (response: Response, fn: () => Promise<unknown>): Promise<unknown> => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => response) as unknown as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  };

  it('returns a file body verbatim when it is not JSON', async () => {
    const csv = 'date,amount\n2026-09-10,42.00\n';
    const body = await withFetch(new Response(csv, { headers: { 'content-type': 'text/csv' } }), () =>
      callGoogle('t', { method: 'GET', url: 'https://example.test/f' }),
    );
    expect(body).toBe(csv);
  });

  it('parses a body Google labels as JSON', async () => {
    const body = await withFetch(
      new Response('{"id":"x"}', { headers: { 'content-type': 'application/json; charset=UTF-8' } }),
      () => callGoogle('t', { method: 'GET', url: 'https://example.test/f' }),
    );
    expect(body).toEqual({ id: 'x' });
  });

  it('treats an empty body as success, which is what a delete returns', async () => {
    const body = await withFetch(new Response('', { status: 204 }), () =>
      callGoogle('t', { method: 'DELETE', url: 'https://example.test/f' }),
    );
    expect(body).toEqual({ ok: true });
  });

  it('surfaces the message from a Google error envelope', async () => {
    const err = JSON.stringify({ error: { message: 'File not found: abc' } });
    await expect(
      withFetch(new Response(err, { status: 404, headers: { 'content-type': 'application/json' } }), () =>
        callGoogle('t', { method: 'GET', url: 'https://example.test/f' }),
      ),
    ).rejects.toThrow('File not found: abc');
  });
});
