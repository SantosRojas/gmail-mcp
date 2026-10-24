import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSemanticTools } from '../src/tools/semanticTools.js';
import { setTestEmbedder } from '../src/utils/embeddings.js';
import type { AppConfig } from '../src/config.js';
import type { GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'gmail-semantic-'));
  setTestEmbedder(async (texts) => texts.map((text) => (text.includes('contrato') ? [1, 0] : [0, 1])));
});

afterEach(async () => {
  setTestEmbedder(null);
  await rm(tempDir, { recursive: true, force: true });
});

function harness(ttlHours: number): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const gmail = {
    users: {
      threads: {
        list: async () => ({
          data: {
            threads: [
              { id: 't1', snippet: 'firma del contrato marco', historyId: 'h1' },
              { id: 't2', snippet: 'fiesta de fin de año', historyId: 'h2' },
            ],
          },
        }),
        get: async () => ({ data: { messages: [{ payload: { headers: [{ name: 'From', value: 'a@x.com' }] } }] } }),
      },
    },
  } as unknown as GmailClient;
  const config = {
    semanticModel: 'stub-model',
    semanticIndexPath: join(tempDir, 'index.json'),
    semanticIndexTtlHours: ttlHours,
    maxIndexThreads: 500,
  } as AppConfig;
  registerSemanticTools(server as unknown as McpServer, gmail, config);
  return handlers;
}

function parseText(result: Record<string, unknown>): Record<string, unknown> {
  const content = (result.content as Array<{ text: string }> | undefined)?.[0]?.text ?? '{}';
  return JSON.parse(content) as Record<string, unknown>;
}

describe('semantic tools', () => {
  it('reindexes and ranks by meaning without touching the real model', async () => {
    const handlers = harness(24);
    const built = parseText((await handlers.get('gmail_reindex_semantic')?.({})) as Record<string, unknown>);
    expect(built.indexed_threads).toBe(2);

    const found = parseText((await handlers.get('gmail_semantic_search')?.({ query: 'contrato', max_results: 5 })) as Record<
      string,
      unknown
    >);
    const threads = found.threads as Array<{ thread_id: string }>;
    expect(found.count).toBe(2);
    expect(threads[0]?.thread_id).toBe('t1');
    expect(found.index_stale).toBe(false);
  });

  it('flags stale indexes instead of silently serving them', async () => {
    const handlers = harness(0);
    await handlers.get('gmail_reindex_semantic')?.({});
    // TTL 0 means "stale immediately"; wait one tick so builtAt < now even
    // on fast runners where both calls land in the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const found = parseText((await handlers.get('gmail_semantic_search')?.({ query: 'contrato', max_results: 5 })) as Record<
      string,
      unknown
    >);
    expect(found.index_stale).toBe(true);
    expect(found.hint).toContain('gmail_reindex_semantic');
  });
});
