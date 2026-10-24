export type QueryValidation = { ok: true; normalized: string } | { ok: false; error: string };

const MAX_QUERY_LENGTH = 2048;

function unbalancedParens(query: string): string | null {
  let depth = 0;
  let inQuotes = false;
  for (const char of query) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && char === '(') {
      depth += 1;
    } else if (!inQuotes && char === ')') {
      depth -= 1;
      if (depth < 0) return 'unbalanced parentheses: closing ")" without an opener';
    }
  }
  if (inQuotes) return 'unbalanced double quotes: an opening \'\"\' is never closed';
  if (depth > 0) return `unbalanced parentheses: ${depth} opening "(" never closed`;
  return null;
}

function emptyOperator(query: string): string | null {
  const withoutQuoted = query.replace(/"[^"]*"/g, '""');
  const match = withoutQuoted.match(/([A-Za-z][A-Za-z_]*):(?=\s|$|[)}])/);
  if (match) return `operator "${match[1]}:" has an empty value`;
  return null;
}

export function validateSearchQuery(query: string): QueryValidation {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (!normalized) return { ok: false, error: 'Search query cannot be empty.' };
  if (normalized.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `Search query exceeds ${MAX_QUERY_LENGTH} characters.` };
  }
  const structureError = unbalancedParens(normalized) ?? emptyOperator(normalized);
  if (structureError) {
    return {
      ok: false,
      error: `${structureError}. Gmail ignores malformed syntax and returns zero results, so the query was rejected before calling the API.`,
    };
  }
  return { ok: true, normalized };
}
