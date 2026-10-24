import { describe, expect, it } from 'vitest';
import { registerWriteTools } from '../src/tools/writeTools.js';
import type { AppConfig } from '../src/config.js';
import type { AuditLogger, GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface Spy {
  sendCalls: number;
  draftRaws: string[];
}

function forwardHarness(): { handlers: Map<string, ToolHandler>; spy: Spy; audits: string[] } {
  const spy: Spy = { sendCalls: 0, draftRaws: [] };
  const audits: string[] = [];
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
      threads: { get: async () => ({ data: { messages: [] } }) },
      drafts: {
        create: async (request: { requestBody?: { message?: { raw?: string } } }) => {
          const raw = request.requestBody?.message?.raw ?? '';
          spy.draftRaws.push(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
          return { data: { id: 'd-fwd' } };
        },
      },
      messages: {
        get: async (request: { id?: string }) => {
          if (request.id !== 'm9') throw new Error('Not found');
          return {
            data: {
              id: 'm9',
              threadId: 't9',
              labelIds: ['INBOX'],
              payload: {
                mimeType: 'text/plain',
                headers: [
                  { name: 'From', value: 'Origen <origen@example.com>' },
                  { name: 'Date', value: 'Mon, 05 Oct 2026 10:00:00 -0500' },
                  { name: 'Subject', value: 'Reporte Q3' },
                ],
                body: { data: toBase64Url('contenido original') },
              },
            },
          };
        },
        send: async () => {
          spy.sendCalls += 1;
          return { data: {} };
        },
      },
    },
  } as unknown as GmailClient;
  const config = {
    maxRecipients: 20,
    maxSubjectLength: 998,
    maxBodyLength: 200000,
    maxMessageBodyChars: 20000,
    maxThreadBodyChars: 60000,
    allowedRecipientDomains: null,
  } as AppConfig;
  const auditLog: AuditLogger = {
    write: async (entry) => {
      audits.push(entry.tool_name);
    },
  };
  registerWriteTools(server as unknown as McpServer, gmail, config, auditLog);
  return { handlers, spy, audits };
}

describe('gmail_forward_message', () => {
  it('creates a quoted forward draft without sending', async () => {
    const { handlers, spy, audits } = forwardHarness();
    const result = (await handlers.get('gmail_forward_message')?.({
      message_id: 'm9',
      to: ['dest@example.com'],
      comment: 'Mira esto',
    })) as unknown as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(body.status).toBe('drafted');
    expect(body.subject).toContain('Reporte Q3');
    expect(spy.sendCalls).toBe(0);
    expect(spy.draftRaws).toHaveLength(1);
    const mimeBody = (spy.draftRaws[0] ?? '').split('\r\n\r\n')[1] ?? '';
    const decodedBody = Buffer.from(mimeBody.replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(decodedBody).toContain('Forwarded message');
    expect(decodedBody).toContain('contenido original');
    expect(audits).toContain('gmail_forward_message');
  });

  it('fails clearly for unknown messages without creating anything', async () => {
    const { handlers, spy } = forwardHarness();
    const result = (await handlers.get('gmail_forward_message')?.({
      message_id: 'missing',
      to: ['dest@example.com'],
    })) as unknown as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(spy.draftRaws).toHaveLength(0);
    expect(spy.sendCalls).toBe(0);
  });
});
