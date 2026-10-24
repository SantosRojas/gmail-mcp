import { describe, expect, it } from 'vitest';
import { registerWriteTools } from '../src/tools/writeTools.js';
import type { AppConfig } from '../src/config.js';
import type { AuditLogger, GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface Spy {
  sendCalls: number;
}

function previewHarness(): { handlers: Map<string, ToolHandler>; spy: Spy } {
  const spy: Spy = { sendCalls: 0 };
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const gmail = {
    users: {
      threads: {
        get: async () => ({
          data: {
            messages: [
              {
                payload: {
                  headers: [
                    { name: 'Subject', value: 'Prueba' },
                    { name: 'Message-ID', value: '<orig@example.com>' },
                  ],
                },
              },
            ],
          },
        }),
      },
      drafts: { create: async () => ({ data: {} }) },
      messages: {
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
    allowedRecipientDomains: null,
  } as AppConfig;
  const auditLog: AuditLogger = { write: async () => undefined };
  registerWriteTools(server as unknown as McpServer, gmail, config, auditLog);
  return { handlers, spy };
}

describe('gmail_preview_message', () => {
  it('shows what would be sent without calling the send API', async () => {
    const { handlers, spy } = previewHarness();
    const result = (await handlers.get('gmail_preview_message')?.({
      to: ['dest@example.com'],
      subject: 'Hola',
      body: 'cuerpo del mensaje',
    })) as unknown as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(body.to).toEqual(['dest@example.com']);
    expect(body.subject).toBe('Hola');
    expect(body.body_chars).toBe('cuerpo del mensaje'.length);
    expect(body.sent).toBe(false);
    expect(body.status).toBe('preview_only');
    expect(spy.sendCalls).toBe(0);
  });

  it('resolves reply headers for thread replies without sending', async () => {
    const { handlers, spy } = previewHarness();
    const result = (await handlers.get('gmail_preview_message')?.({
      to: ['dest@example.com'],
      subject: 'Prueba',
      body: 'respuesta',
      thread_id: 't1',
    })) as unknown as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(body.in_reply_to).toBe('<orig@example.com>');
    expect(body.thread_id).toBe('t1');
    expect(spy.sendCalls).toBe(0);
  });

  it('reports validation failures as errors without sending', async () => {
    const { handlers, spy } = previewHarness();
    const result = (await handlers.get('gmail_preview_message')?.({
      to: ['dest@example.com'],
      subject: '   ',
      body: 'x',
    })) as unknown as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(spy.sendCalls).toBe(0);
  });

  it('echoes cc recipients and enforces the combined recipient limit', async () => {
    const { handlers, spy } = previewHarness();
    const ok = (await handlers.get('gmail_preview_message')?.({
      to: ['a@example.com'],
      cc: ['b@example.com'],
      bcc: ['c@example.com'],
      subject: 'Hola',
      body: 'x',
    })) as unknown as { content: Array<{ text: string }> };
    const echoed = JSON.parse(ok.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(echoed.cc).toEqual(['b@example.com']);
    expect(echoed.bcc).toEqual(['c@example.com']);
    expect(spy.sendCalls).toBe(0);

    const tooMany = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`);
    const rejected = (await handlers.get('gmail_preview_message')?.({
      to: tooMany.slice(0, 10),
      cc: tooMany.slice(10),
      subject: 'Hola',
      body: 'x',
    })) as unknown as { isError: boolean };
    expect(rejected.isError).toBe(true);
  });
});
