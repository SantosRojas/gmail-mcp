import { describe, expect, it } from 'vitest';
import { registerReadTools } from '../src/tools/readTools.js';
import type { AppConfig } from '../src/config.js';
import type { GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:future@example.com',
  'DTSTART:20300107T150000Z',
  'DTEND:20300107T160000Z',
  'SUMMARY:Revision futura',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:past@example.com',
  'DTSTART:20200107T150000Z',
  'SUMMARY:Evento viejo',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function upcomingHarness(): { handlers: Map<string, ToolHandler>; requestedIds: string[] } {
  const requestedIds: string[] = [];
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const toBase64Url = (text: string): string =>
    Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const gmail = {
    users: {
      threads: {
        list: async () => ({ data: { threads: [{ id: 't1', snippet: '', historyId: 'h' }] } }),
        get: async () => ({
          data: {
            id: 't1',
            messages: [
              {
                id: 'm1',
                payload: {
                  parts: [{ filename: 'invite.ics', mimeType: 'text/calendar', body: { attachmentId: 'fresh-1', size: 400 } }],
                },
              },
            ],
          },
        }),
      },
      labels: { list: async () => ({ data: { labels: [] } }) },
      drafts: { list: async () => ({ data: { drafts: [] } }) },
      messages: {
        get: async () => ({ data: { id: 'm1', payload: {} } }),
        attachments: {
          get: async (request: { id?: string }) => {
            requestedIds.push(request.id ?? '');
            return { data: { data: toBase64Url(ICS), size: 400 } };
          },
        },
      },
    },
  } as unknown as GmailClient;
  const config = { maxAttachmentBytes: 1024 * 1024, maxMessageBodyChars: 20000, maxThreadBodyChars: 60000 } as AppConfig;
  registerReadTools(server as unknown as McpServer, gmail, config);
  return { handlers, requestedIds };
}

describe('gmail_upcoming_events', () => {
  it('lists future invite events and skips past ones', async () => {
    const { handlers, requestedIds } = upcomingHarness();
    const result = (await handlers.get('gmail_upcoming_events')?.({ days_ahead: 365 * 10, max_threads: 5 })) as Record<
      string,
      unknown
    >;
    const body = JSON.parse(
      (result.content as Array<{ text: string }>)[0]?.text ?? '{}',
    ) as { count: number; events: Array<{ summary: string }> };
    expect(body.count).toBe(1);
    expect(body.events[0]?.summary).toBe('Revision futura');
    expect(requestedIds).toEqual(['fresh-1']);
  });
});
