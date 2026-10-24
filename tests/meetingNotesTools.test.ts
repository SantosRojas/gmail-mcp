import { describe, expect, it } from 'vitest';
import { registerReadTools } from '../src/tools/readTools.js';
import type { AppConfig } from '../src/config.js';
import type { GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function encode(data: string): string {
  return Buffer.from(data, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function handlersForThread(threadData: unknown): Map<string, ToolHandler> {
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

function parseText(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

describe('gmail meeting notes tools', () => {
  it('exposes meeting_notes in gmail_get_thread_summary', async () => {
    const handlers = handlersForThread({
      id: 't-notes',
      historyId: 'h1',
      messages: [
        {
          id: 'm1',
          threadId: 't-notes',
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/html',
            headers: [
              { name: 'From', value: 'Gemini <gemini-notes@google.com>' },
              { name: 'Subject', value: 'Notas: Mr IA' },
            ],
            body: { data: encode('<a href="https://docs.google.com/document/d/xyz/edit">Abrir notas</a>') },
          },
        },
      ],
    });
    const result = await handlers.get('gmail_get_thread_summary')?.({ thread_id: 't-notes' });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.meeting_notes.provider).toBe('gemini');
    expect(body.meeting_notes.has_notes).toBe(true);
    expect(body.meeting_notes.doc_urls).toEqual(['https://docs.google.com/document/d/xyz/edit']);
  });

  it('gmail_get_meeting_notes returns links without summary body', async () => {
    const handlers = handlersForThread({
      id: 't-read',
      historyId: 'h2',
      messages: [
        {
          id: 'm1',
          threadId: 't-read',
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/html',
            headers: [
              { name: 'From', value: 'Team via Read AI <executiveassistant@e.read.ai>' },
              { name: 'Subject', value: 'Informe de la Reunión' },
            ],
            body: { data: encode('<a href="https://read.ai/meet/abc">Ver Informe</a>') },
          },
        },
      ],
    });
    const result = await handlers.get('gmail_get_meeting_notes')?.({ thread_id: 't-read' });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.thread_id).toBe('t-read');
    expect(body.meeting_notes.provider).toBe('read_ai');
    expect(body.meeting_notes.report_urls).toEqual(['https://read.ai/meet/abc']);
    expect(body.summary).toBeUndefined();
  });

  it('gmail_get_meeting_notes reports none for regular mail', async () => {
    const handlers = handlersForThread({
      id: 't-plain',
      historyId: 'h3',
      messages: [
        {
          id: 'm1',
          threadId: 't-plain',
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'a@example.com' },
              { name: 'Subject', value: 'Hola' },
            ],
            body: { data: encode('hola mundo') },
          },
        },
      ],
    });
    const result = await handlers.get('gmail_get_meeting_notes')?.({ thread_id: 't-plain' });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.meeting_notes).toMatchObject({ provider: 'none', has_notes: false });
  });
});
