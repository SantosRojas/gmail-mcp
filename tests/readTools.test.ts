import { describe, expect, it } from 'vitest';
import { registerReadTools } from '../src/tools/readTools.js';
import type { AppConfig } from '../src/config.js';
import type { GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function handlersFor(listResponse: unknown): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const gmail = {
    users: { threads: { list: async () => ({ data: listResponse }) } },
  } as unknown as GmailClient;
  registerReadTools(server as unknown as McpServer, gmail, {} as AppConfig);
  return handlers;
}

function handlersWithSpy(listImpl: () => Promise<unknown>): {
  handlers: Map<string, ToolHandler>;
  calls: number;
  lastParams: Record<string, unknown> | null;
} {
  let calls = 0;
  let lastParams: Record<string, unknown> | null = null;
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const gmail = {
    users: {
      threads: {
        list: async (params: unknown) => {
          calls += 1;
          lastParams = params as Record<string, unknown>;
          return { data: await listImpl() };
        },
      },
      labels: { list: async () => ({ data: { labels: [] } }) },
      drafts: { list: async () => ({ data: { drafts: [] } }) },
    },
  } as unknown as GmailClient;
  registerReadTools(server as unknown as McpServer, gmail, {} as AppConfig);
  return {
    handlers,
    get calls() {
      return calls;
    },
    get lastParams() {
      return lastParams;
    },
  };
}

function parseText(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function summaryHandlers(threadData: unknown): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const gmail = {
    users: {
      threads: {
        list: async () => ({ data: { threads: [] } }),
        get: async () => ({ data: threadData }),
      },
      labels: { list: async () => ({ data: { labels: [] } }) },
      drafts: { list: async () => ({ data: { drafts: [] } }) },
    },
  } as unknown as GmailClient;
  registerReadTools(server as unknown as McpServer, gmail, {
    maxMessageBodyChars: 20000,
    maxThreadBodyChars: 60000,
  } as AppConfig);
  return handlers;
}

function threadMessage(id: string): Record<string, unknown> {
  return {
    id,
    threadId: 't9',
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: 's' }],
      body: { data: Buffer.from(`cuerpo ${id}`, 'utf8').toString('base64') },
    },
  };
}

function readHandlers(stubs: { labels?: unknown; drafts?: unknown }): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const gmail = {
    users: {
      threads: { list: async () => ({ data: { threads: [] } }) },
      labels: { list: async () => ({ data: stubs.labels ?? { labels: [] } }) },
      drafts: { list: async () => ({ data: stubs.drafts ?? { drafts: [] } }) },
    },
  } as unknown as GmailClient;
  registerReadTools(server as unknown as McpServer, gmail, {} as AppConfig);
  return handlers;
}

describe('gmail_list_labels', () => {
  it('returns label metadata without message content', async () => {
    const handlers = readHandlers({
      labels: { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 100, messagesUnread: 7 }] },
    });
    const result = await handlers.get('gmail_list_labels')?.({});
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.count).toBe(1);
    expect(body.labels).toEqual([
      { id: 'INBOX', name: 'INBOX', type: 'system', messages_total: 100, messages_unread: 7 },
    ]);
  });

  it('reports null counts when Gmail omits them', async () => {
    const handlers = readHandlers({ labels: { labels: [{ id: 'X', name: 'X' }] } });
    const result = await handlers.get('gmail_list_labels')?.({});
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.labels).toEqual([{ id: 'X', name: 'X', type: '', messages_total: null, messages_unread: null }]);
  });

  it('estimates counts on demand without touching the default path', async () => {
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    };
    const gmail = {
      users: {
        threads: {
          list: async () => ({ data: { threads: [], resultSizeEstimate: 9 } }),
          get: async () => ({ data: { messages: [] } }),
        },
        labels: { list: async () => ({ data: { labels: [{ id: 'INBOX', name: 'INBOX' }] } }) },
        drafts: { list: async () => ({ data: { drafts: [] } }) },
      },
    } as unknown as GmailClient;
    registerReadTools(server as unknown as McpServer, gmail, {} as AppConfig);
    const result = await handlers.get('gmail_list_labels')?.({ include_counts: true });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.labels).toEqual([
      { id: 'INBOX', name: 'INBOX', type: '', messages_total: 9, messages_unread: 9 },
    ]);
  });
});

describe('gmail_list_drafts', () => {
  it('returns draft identifiers for review before sending', async () => {
    const handlers = readHandlers({
      drafts: { drafts: [{ id: 'd1', message: { id: 'm1', threadId: 't1' } }], resultSizeEstimate: 1 },
    });
    const result = await handlers.get('gmail_list_drafts')?.({ max_results: 10 });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.count).toBe(1);
    expect(body.result_size_estimate).toBe(1);
    expect(body.drafts).toEqual([{ draft_id: 'd1', message_id: 'm1', thread_id: 't1' }]);
  });
});

describe('gmail_list_threads output', () => {
  it('exposes the Gmail result size estimate alongside the returned threads', async () => {
    const handlers = handlersFor({
      resultSizeEstimate: 201,
      threads: [{ id: 't1', snippet: 'hello', historyId: 'h1' }],
    });
    const result = await handlers.get('gmail_list_threads')?.({ query: 'in:inbox', max_results: 5 });
    expect(result).toBeDefined();
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.count).toBe(1);
    expect(body.result_size_estimate).toBe(201);
  });

  it('reports null estimate when Gmail omits it', async () => {
    const handlers = handlersFor({ threads: [] });
    const result = await handlers.get('gmail_list_threads')?.({ query: 'in:inbox', max_results: 5 });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.count).toBe(0);
    expect(body.result_size_estimate).toBeNull();
  });

  it('rejects malformed queries before calling the Gmail API', async () => {
    const { handlers, calls } = handlersWithSpy(async () => ({ threads: [] }));
    await expect(handlers.get('gmail_list_threads')?.({ query: 'in:inbox (((malformed', max_results: 5 })).rejects.toThrow(
      /zero results/,
    );
    expect(calls).toBe(0);
  });

  it('forwards page tokens and reports the next page', async () => {    const spied = handlersWithSpy(async () => ({ threads: [], nextPageToken: 'tok-2' }));
    const result = await spied.handlers.get('gmail_list_threads')?.({ query: 'in:inbox', max_results: 5 });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.next_page_token).toBe('tok-2');
    expect(spied.lastParams).toMatchObject({ q: 'in:inbox' });

    const spiedPaged = handlersWithSpy(async () => ({ threads: [] }));
    const paged = await spiedPaged.handlers.get('gmail_list_threads')?.({
      query: 'in:inbox',
      max_results: 5,
      page_token: 'tok-2',
    });
    const pagedBody = parseText(paged as { content: Array<{ text: string }> });
    expect(pagedBody.next_page_token).toBeNull();
    expect(spiedPaged.lastParams).toMatchObject({ pageToken: 'tok-2' });
  });

  it('enriches threads with From/Date only when include_from is set', async () => {
    let getCalls = 0;
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    };
    const gmail = {
      users: {
        threads: {
          list: async () => ({ data: { threads: [{ id: 't1', snippet: 's', historyId: 'h' }] } }),
          get: async () => {
            getCalls += 1;
            return { data: { messages: [{ payload: { headers: [{ name: 'From', value: 'a@x.com' }] } }] } };
          },
        },
        labels: { list: async () => ({ data: { labels: [] } }) },
        drafts: { list: async () => ({ data: { drafts: [] } }) },
      },
    } as unknown as GmailClient;
    registerReadTools(server as unknown as McpServer, gmail, {} as AppConfig);

    const enriched = parseText((await handlers.get('gmail_list_threads')?.({
      query: 'in:inbox',
      max_results: 5,
      include_from: true,
    })) as { content: Array<{ text: string }> });
    expect((enriched.threads as Array<Record<string, string>>)[0]).toMatchObject({ from: 'a@x.com' });
    expect(getCalls).toBe(1);

    const plain = parseText((await handlers.get('gmail_list_threads')?.({ query: 'in:inbox', max_results: 5 })) as {
      content: Array<{ text: string }>;
    });
    expect((plain.threads as Array<Record<string, string>>)[0]?.from).toBe('');
  });

  it('paginates long threads and reports omission with a resume hint', async () => {
    const handlers = summaryHandlers({
      id: 't9',
      historyId: 'h9',
      messages: [threadMessage('m1'), threadMessage('m2'), threadMessage('m3')],
    });
    const getSummary = handlers.get('gmail_get_thread_summary') as ToolHandler;
    const first = parseText((await getSummary({ thread_id: 't9', start_message: 1, max_messages: 2 })) as {
      content: Array<{ text: string }>;
    });
    expect(first.message_count).toBe(3);
    expect(first.messages_included).toBe(2);
    expect(first.messages_omitted).toBe(1);
    expect(first.truncated).toBe(true);
    expect(first.next_start_message).toBe(3);

    const full = parseText((await getSummary({ thread_id: 't9', start_message: 1, max_messages: 10 })) as {
      content: Array<{ text: string }>;
    });
    expect(full.messages_omitted).toBe(0);
    expect(full.truncated).toBe(false);
  });
});
