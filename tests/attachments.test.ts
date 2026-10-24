import { describe, expect, it } from 'vitest';
import { registerReadTools } from '../src/tools/readTools.js';
import type { AppConfig } from '../src/config.js';
import type { GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface AttachmentSpy {
  attachmentsGetCalls: number;
  requestedIds: string[];
}

function attachmentHarness(parts: Array<{ filename: string; mimeType: string; id: string; size: number; text: string }>): {
  handlers: Map<string, ToolHandler>;
  spy: AttachmentSpy;
} {
  const spy: AttachmentSpy = { attachmentsGetCalls: 0, requestedIds: [] };
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const toBase64Url = (text: string): string =>
    Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const byId = new Map(parts.map((part) => [part.id, part]));
  const gmail = {
    users: {
      threads: {
        list: async () => ({ data: { threads: [] } }),
        get: async () => ({ data: { messages: [] } }),
      },
      labels: { list: async () => ({ data: { labels: [] } }) },
      drafts: { list: async () => ({ data: { drafts: [] } }) },
      messages: {
        get: async () => ({
          data: {
            id: 'm1',
            payload: {
              parts: parts.map((part) => ({
                filename: part.filename,
                mimeType: part.mimeType,
                body: { attachmentId: part.id, size: part.size },
              })),
            },
          },
        }),
        attachments: {
          get: async (request: { id?: string }) => {
            spy.attachmentsGetCalls += 1;
            spy.requestedIds.push(request.id ?? '');
            const part = byId.get(request.id ?? '');
            return { data: { data: part ? toBase64Url(part.text) : '', size: part?.size ?? 0 } };
          },
        },
      },
    },
  } as unknown as GmailClient;
  const config = { maxAttachmentBytes: 1024, maxMessageBodyChars: 20000, maxThreadBodyChars: 60000 } as AppConfig;
  registerReadTools(server as unknown as McpServer, gmail, config);
  return { handlers, spy };
}

function parseText(result: Record<string, unknown>): Record<string, unknown> {
  const content = (result.content as Array<{ text: string }> | undefined)?.[0]?.text ?? '{}';
  return JSON.parse(content) as Record<string, unknown>;
}

describe('gmail_get_attachment', () => {
  it('resolves the fresh attachment id by filename and returns decoded content', async () => {
    const { handlers, spy } = attachmentHarness([{ filename: 'nota.txt', mimeType: 'text/plain', id: 'fresh-id-1', size: 100, text: 'hola adjunto' }]);
    const result = (await handlers.get('gmail_get_attachment')?.({ message_id: 'm1', filename: 'nota.txt', part_index: 0 })) as Record<
      string,
      unknown
    >;
    const body = parseText(result);
    expect(body.filename).toBe('nota.txt');
    expect(body.mime_type).toBe('text/plain');
    expect(body.content_base64).toBe(Buffer.from('hola adjunto', 'utf8').toString('base64'));
    expect(spy.attachmentsGetCalls).toBe(1);
    expect(spy.requestedIds).toEqual(['fresh-id-1']);
  });

  it('selects among duplicate filenames with part_index', async () => {
    const { handlers } = attachmentHarness([
      { filename: 'invite.ics', mimeType: 'text/calendar', id: 'id-a', size: 10, text: 'primero' },
      { filename: 'invite.ics', mimeType: 'application/ics', id: 'id-b', size: 10, text: 'segundo' },
    ]);
    const result = (await handlers.get('gmail_get_attachment')?.({
      message_id: 'm1',
      filename: 'invite.ics',
      part_index: 1,
    })) as Record<string, unknown>;
    const body = parseText(result);
    expect(body.mime_type).toBe('application/ics');
    expect(body.content_base64).toBe(Buffer.from('segundo', 'utf8').toString('base64'));
  });

  it('refuses content over the limit without downloading bytes', async () => {
    const { handlers, spy } = attachmentHarness([
      { filename: 'grande.bin', mimeType: 'application/octet-stream', id: 'id-big', size: 10 * 1024 * 1024, text: '' },
    ]);
    const result = (await handlers.get('gmail_get_attachment')?.({ message_id: 'm1', filename: 'grande.bin', part_index: 0 })) as Record<
      string,
      unknown
    >;
    const body = parseText(result);
    expect(body.content_base64 ?? null).toBeNull();
    expect(body.truncated_by_limit).toBe(true);
    expect(spy.attachmentsGetCalls).toBe(0);
  });

  it('lists available filenames when nothing matches', async () => {
    const { handlers, spy } = attachmentHarness([
      { filename: 'nota.txt', mimeType: 'text/plain', id: 'id-1', size: 10, text: 'x' },
    ]);
    const result = (await handlers.get('gmail_get_attachment')?.({ message_id: 'm1', filename: 'otro.txt' })) as Record<
      string,
      unknown
    >;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('nota.txt');
    expect(spy.attachmentsGetCalls).toBe(0);
  });
});
