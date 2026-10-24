import { describe, expect, it } from 'vitest';
import { validateSearchQuery } from '../src/utils/queryValidator.js';

describe('validateSearchQuery', () => {
  it('accepts well-formed queries and normalizes whitespace', () => {
    const result = validateSearchQuery('  from:boss@company.com   has:attachment newer_than:7d  ');
    expect(result).toEqual({ ok: true, normalized: 'from:boss@company.com has:attachment newer_than:7d' });
  });

  it('accepts grouped and quoted queries', () => {
    const result = validateSearchQuery('from:(a@x.com OR b@x.com) subject:"quarterly report"');
    expect(result.ok).toBe(true);
  });

  it('rejects empty queries', () => {
    const result = validateSearchQuery('   ');
    expect(result.ok).toBe(false);
  });

  it('rejects unbalanced parentheses', () => {
    const unclosed = validateSearchQuery('in:inbox (((malformed');
    expect(unclosed.ok).toBe(false);
    if (!unclosed.ok) expect(unclosed.error).toContain('parentheses');

    const unopened = validateSearchQuery('in:inbox) extra');
    expect(unopened.ok).toBe(false);
  });

  it('rejects unbalanced quotes', () => {
    const result = validateSearchQuery('subject:"never closed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('quotes');
  });

  it('rejects operators with empty values', () => {
    const result = validateSearchQuery('in:inbox from:');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('from:');
  });

  it('explains that Gmail would silently return zero results', () => {
    const result = validateSearchQuery('(((');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('zero results');
  });
});
