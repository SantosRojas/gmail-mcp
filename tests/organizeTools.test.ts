import { describe, expect, it } from 'vitest';
import { registerOrganizeTools } from '../src/tools/organizeTools.js';
import type { AppConfig } from '../src/config.js';
import type { AuditLogger, GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

interface HandlerResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<HandlerResult>;

interface Calls {
  filtersCreated: number;
}

function organizeHarness(): { handlers: Map<string, ToolHandler>; calls: Calls } {
  const calls: Calls = { filtersCreated: 0 };
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const gmail = {
    users: {
      messages: { trash: async () => ({ data: {} }), modify: async () => ({ data: {} }) },
      threads: { trash: async () => ({ data: {} }), modify: async () => ({ data: {} }) },
      settings: {
        filters: {
          list: async () => ({ data: { filter: [] } }),
          create: async () => {
            calls.filtersCreated += 1;
            return { data: { id: 'f1' } };
          },
          delete: async () => ({ data: {} }),
        },
      },
    },
  } as unknown as GmailClient;
  const auditLog: AuditLogger = { write: async () => undefined };
  registerOrganizeTools(server as unknown as McpServer, gmail, {} as AppConfig, auditLog);
  return { handlers, calls };
}

describe('gmail_create_filter guardrails', () => {
  it('rejects TRASH in filter actions instead of bypassing the soft-delete guardrail', async () => {
    const { handlers, calls } = organizeHarness();
    const result = await handlers.get('gmail_create_filter')?.({
      criteria: { from: 'promo@example.com' },
      action: { add_labels: ['TRASH'] },
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toMatch(/TRASH is protected/);
    expect(calls.filtersCreated).toBe(0);
  });
});
