import { describe, expect, it } from 'vitest';
import { registerManageTools } from '../src/tools/manageTools.js';
import type { AppConfig } from '../src/config.js';
import type { AuditLogger, GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface Calls {
  untrash: number;
  getLabels: Array<string> | null;
  modify: unknown | null;
}

function manageHarness(labelIds: Array<string> | null): { handlers: Map<string, ToolHandler>; calls: Calls } {
  const calls: Calls = { untrash: 0, getLabels: null, modify: null };
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const gmail = {
    users: {
      messages: {
        untrash: async () => {
          calls.untrash += 1;
          return { data: {} };
        },
        get: async () => ({ data: labelIds === null ? {} : { labelIds } }),
        modify: async (request: unknown) => {
          calls.modify = request;
          return { data: {} };
        },
      },
      threads: {
        untrash: async () => ({ data: {} }),
      },
    },
  } as unknown as GmailClient;
  const auditLog: AuditLogger = { write: async () => undefined };
  registerManageTools(server as unknown as McpServer, gmail, {} as AppConfig, auditLog);
  return { handlers, calls };
}

function parseText(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('gmail_restore_message inbox placement', () => {
  it('re-adds INBOX when untrash leaves the message outside every mailbox', async () => {
    const { handlers, calls } = manageHarness(['UNREAD', 'CATEGORY_PROMOTIONS']);
    const result = await handlers.get('gmail_restore_message')?.({ id: 'm1', type: 'message' });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.status).toBe('restored');
    expect(body.placement).toBe('inbox_restored');
    expect(calls.untrash).toBe(1);
    expect(JSON.stringify(calls.modify)).toContain('INBOX');
  });

  it('leaves placement untouched for sent mail', async () => {
    const { handlers, calls } = manageHarness(['SENT']);
    const result = await handlers.get('gmail_restore_message')?.({ id: 'm1', type: 'message' });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.status).toBe('restored');
    expect(body.placement).toBe('unchanged');
    expect(calls.modify).toBeNull();
  });

  it('leaves placement untouched when INBOX is already present', async () => {
    const { handlers, calls } = manageHarness(['INBOX', 'UNREAD']);
    const result = await handlers.get('gmail_restore_message')?.({ id: 'm1', type: 'message' });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.placement).toBe('unchanged');
    expect(calls.modify).toBeNull();
  });
});
