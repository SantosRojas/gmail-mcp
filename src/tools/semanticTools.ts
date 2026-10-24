import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../config.js';
import type { GmailClient } from '../types/index.js';
import { mcpError, mcpText, extractGoogleError } from './common.js';
import { fetchThreadHeaders } from '../utils/gmail.js';
import { embedTexts } from '../utils/embeddings.js';
import { isIndexStale, parseIndex, rankThreads, serializeIndex, type SemanticIndex } from '../utils/semantic.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadIndex(indexPath: string, model: string): Promise<SemanticIndex | null> {
  try {
    return parseIndex(await readFile(indexPath, 'utf8'), model);
  } catch {
    return null;
  }
}

async function saveIndex(indexPath: string, index: SemanticIndex): Promise<void> {
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, `${serializeIndex(index)}\n`, { mode: 0o600 });
  await chmod(indexPath, 0o600);
}

async function buildIndex(gmail: GmailClient, config: AppConfig): Promise<SemanticIndex> {
  const found: Array<{ id: string; snippet: string; from: string; date: string }> = [];
  let pageToken: string | undefined;
  while (found.length < config.maxIndexThreads) {
    const remaining = Math.min(50, config.maxIndexThreads - found.length);
    const response = await gmail.users.threads.list({
      userId: 'me',
      q: 'in:inbox',
      maxResults: remaining,
      ...(pageToken ? { pageToken } : {}),
    });
    const batch = response.data.threads ?? [];
    if (batch.length === 0) break;
    for (const thread of batch) {
      const meta = await fetchThreadHeaders(gmail, thread.id ?? '');
      found.push({ id: thread.id ?? '', snippet: thread.snippet ?? '', from: meta.from, date: meta.date });
      await delay(300);
    }
    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  const embeddings = await embedTexts(
    found.map((entry) => `${entry.from} ${entry.snippet}`.trim()),
    config.semanticModel,
  );
  return {
    builtAt: new Date().toISOString(),
    model: config.semanticModel,
    threads: found.map((entry, index) => ({ ...entry, embedding: embeddings[index] ?? [] })),
  };
}

async function loadOrBuildIndex(gmail: GmailClient, config: AppConfig): Promise<{ index: SemanticIndex; stale: boolean; builtNow: boolean }> {
  const existing = await loadIndex(config.semanticIndexPath, config.semanticModel);
  if (existing) {
    return { index: existing, stale: isIndexStale(existing.builtAt, config.semanticIndexTtlHours), builtNow: false };
  }
  const fresh = await buildIndex(gmail, config);
  await saveIndex(config.semanticIndexPath, fresh);
  return { index: fresh, stale: false, builtNow: true };
}

export function registerSemanticTools(server: McpServer, gmail: GmailClient, config: AppConfig): void {
  server.registerTool(
    'gmail_reindex_semantic',
    {
      description:
        'Rebuilds the local semantic search index from recent inbox threads. Embeddings run on this machine; nothing leaves it. Read-only toward Gmail.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const index = await buildIndex(gmail, config);
        await saveIndex(config.semanticIndexPath, index);
        return mcpText({ indexed_threads: index.threads.length, model: index.model, built_at: index.builtAt });
      } catch (error) {
        return mcpError('Unable to rebuild semantic index', error);
      }
    },
  );

  server.registerTool(
    'gmail_semantic_search',
    {
      description:
        'Searches inbox threads by meaning using local embeddings (multilingual, incl. Spanish). First run builds the index and is slow. Read-only.',
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe('Natural-language description of what to find'),
        max_results: z.number().int().min(1).max(50).default(10).describe('Maximum threads to return'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, max_results }) => {
      try {
        const { index, stale } = await loadOrBuildIndex(gmail, config);
        const [queryEmbedding] = await embedTexts([query], config.semanticModel);
        const ranked = rankThreads(index.threads, queryEmbedding ?? [], max_results).map((entry) => ({
          ...entry,
          score: Math.round(entry.score * 10000) / 10000,
        }));
        return mcpText({
          query,
          count: ranked.length,
          index_stale: stale,
          ...(stale ? { hint: 'Run gmail_reindex_semantic to refresh the index.' } : {}),
          threads: ranked.map((entry) => ({ thread_id: entry.id, from: entry.from, date: entry.date, snippet: entry.snippet, score: entry.score })),
        });
      } catch (error) {
        return mcpError('Unable to run semantic search', extractGoogleError(error));
      }
    },
  );
}
