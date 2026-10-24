import { readFile } from 'node:fs/promises';
import type { AuditEntry } from '../types/index.js';

export interface AuditQuery {
  tool_name?: string;
  status?: 'success' | 'error';
  search?: string;
  max_results?: number;
}

/** Reads the JSONL audit log tail and filters in memory. Skips malformed lines. Pure I/O helper, unit-testable via temp files. */
export async function queryAuditLog(filePath: string, query: AuditQuery = {}): Promise<{ total_scanned: number; count: number; entries: AuditEntry[] }> {
  const maxResults = Math.min(Math.max(query.max_results ?? 20, 1), 100);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'ENOENT') return { total_scanned: 0, count: 0, entries: [] };
    throw error;
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      continue;
    }
  }
  const needle = query.search?.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    if (query.tool_name && entry.tool_name !== query.tool_name) return false;
    if (query.status && entry.status !== query.status) return false;
    if (needle && !`${entry.tool_name} ${entry.target_id} ${entry.reason} ${entry.error ?? ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  return { total_scanned: entries.length, count: Math.min(filtered.length, maxResults), entries: filtered.slice(-maxResults).reverse() };
}
