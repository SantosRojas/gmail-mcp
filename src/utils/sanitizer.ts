import TurndownService from 'turndown';

const turndown = new TurndownService({
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  bulletListMarker: '-',
  linkStyle: 'inlined',
});

turndown.remove(['script', 'style', 'noscript', 'template']);

const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g;
const LONG_SPACE_RUN_PATTERN = /[ \t\u00A0]{3,}/g;

export function collapseInvisibleNoise(text: string): string {
  const withoutZeroWidth = text.replace(ZERO_WIDTH_PATTERN, '');
  const segments = withoutZeroWidth.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment, index) => (index % 2 === 1 ? segment : segment.replace(LONG_SPACE_RUN_PATTERN, ' ')))
    .join('');
}

const MAX_URL_LENGTH = 160;
const URL_PATTERN = /https?:\/\/[^\s>\]]+/g;

function shortenUrl(url: string): string {
  if (url.length <= MAX_URL_LENGTH) return url;
  const withoutScheme = url.replace(/^https?:\/\//i, '');
  const host = withoutScheme.split(/[/:?#]/, 1)[0] ?? withoutScheme;
  const scheme = url.toLowerCase().startsWith('https') ? 'https' : 'http';
  return `${scheme}://${host}/...[${url.length} chars]`;
}

function splitUrlSuffix(match: string): { url: string; suffix: string } {
  let url = match;
  let suffix = '';
  const punct = url.match(/[.,;:!?]+$/);
  if (punct) {
    suffix = punct[0] + suffix;
    url = url.slice(0, -punct[0].length);
  }
  let open = 0;
  let close = 0;
  for (const char of url) {
    if (char === '(') open += 1;
    else if (char === ')') close += 1;
  }
  while (close > open && url.endsWith(')')) {
    url = url.slice(0, -1);
    suffix = `)${suffix}`;
    close -= 1;
  }
  return { url, suffix };
}

export function shortenLongUrls(text: string): string {
  return text.replace(URL_PATTERN, (match) => {
    const { url, suffix } = splitUrlSuffix(match);
    return shortenUrl(url) + suffix;
  });
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripUnsafeMarkdownLinks(markdown: string): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, label: string, url: string) => {
    const normalized = decodeHtmlEntities(url).trim();
    if (/^(https?:|mailto:)/i.test(normalized)) return full;
    return label;
  });
}

export function htmlToSafeMarkdown(html: string): string {
  const withoutActiveContent = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  const markdown = turndown.turndown(withoutActiveContent);
  return collapseInvisibleNoise(shortenLongUrls(stripUnsafeMarkdownLinks(markdown)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizePlainText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return collapseInvisibleNoise(normalized).trim();
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[CONTENIDO TRUNCADO POR SEGURIDAD Y CONTEXTO]`;
}
