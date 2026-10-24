import { describe, expect, it } from 'vitest';
import { cosineSimilarity, isIndexStale, parseIndex, rankThreads, serializeIndex } from '../src/utils/semantic.js';

describe('cosineSimilarity', () => {
  it('scores identical vectors at 1 and orthogonal at 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns 0 for zero vectors instead of NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('rankThreads', () => {
  const threads = [
    { id: 'a', from: '', date: '', snippet: 'contrato', embedding: [1, 0] },
    { id: 'b', from: '', date: '', snippet: 'fiesta', embedding: [0, 1] },
  ];

  it('ranks by descending similarity and caps results', () => {
    const ranked = rankThreads(threads, [1, 0.1], 10);
    expect(ranked[0]?.id).toBe('a');
    expect(ranked[1]?.id).toBe('b');
    expect(rankThreads(threads, [1, 0], 1)).toHaveLength(1);
  });
});

describe('semantic index serialization', () => {
  it('round-trips and rejects foreign models or corrupt payloads', () => {
    const index = { builtAt: new Date().toISOString(), model: 'm1', threads: [] };
    expect(parseIndex(serializeIndex(index), 'm1')).toEqual(index);
    expect(parseIndex(serializeIndex(index), 'm2')).toBeNull();
    expect(parseIndex('no-json', 'm1')).toBeNull();
  });

  it('detects stale indexes by TTL', () => {
    const old = new Date(Date.now() - 25 * 3600000).toISOString();
    expect(isIndexStale(old, 24)).toBe(true);
    expect(isIndexStale(new Date().toISOString(), 24)).toBe(false);
    expect(isIndexStale('garbage', 24)).toBe(true);
  });
});
