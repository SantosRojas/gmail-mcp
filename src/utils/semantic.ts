export const DEFAULT_SEMANTIC_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

export interface IndexedThread {
  id: string;
  from: string;
  date: string;
  snippet: string;
  embedding: number[];
}

export interface SemanticIndex {
  builtAt: string;
  model: string;
  threads: IndexedThread[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankedThread {
  id: string;
  from: string;
  date: string;
  snippet: string;
  score: number;
}

export function rankThreads(threads: IndexedThread[], queryEmbedding: number[], maxResults: number): RankedThread[] {
  return threads
    .map((thread) => ({
      id: thread.id,
      from: thread.from,
      date: thread.date,
      snippet: thread.snippet,
      score: cosineSimilarity(queryEmbedding, thread.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxResults));
}

export function serializeIndex(index: SemanticIndex): string {
  return JSON.stringify(index);
}

export function parseIndex(raw: string, expectedModel: string): SemanticIndex | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SemanticIndex>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.model !== expectedModel || !Array.isArray(parsed.threads)) return null;
    return { builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : new Date(0).toISOString(), model: parsed.model, threads: parsed.threads };
  } catch {
    return null;
  }
}

export function isIndexStale(builtAt: string, ttlHours: number, now: number = Date.now()): boolean {
  const built = Date.parse(builtAt);
  if (Number.isNaN(built)) return true;
  return now - built > ttlHours * 3600000;
}
