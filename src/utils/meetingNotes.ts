import type { gmail_v1 } from 'googleapis';
import { collectParts as collectGmailParts, decodeBase64Url, headerValue } from './gmail.js';

export type MeetingNotesProvider = 'gemini' | 'read_ai' | 'unknown' | 'none';

export interface MeetingNotes {
  provider: MeetingNotesProvider;
  has_notes: boolean;
  doc_urls: string[];
  report_urls: string[];
  content_warning: string;
}

const MAX_URLS = 20;

function walkParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  output: gmail_v1.Schema$MessagePart[],
): void {
  collectGmailParts(part, output);
}

function stripTrailingPunct(url: string): string {
  let cleaned = url.replace(/[.,;:!?]+$/, '');
  let open = 0;
  let close = 0;
  for (const char of cleaned) {
    if (char === '(') open += 1;
    else if (char === ')') close += 1;
  }
  while (close > open && cleaned.endsWith(')')) {
    cleaned = cleaned.slice(0, -1);
    close -= 1;
  }
  return cleaned;
}

export function extractUrlsFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>\]"')]+/g) ?? [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of matches) {
    const url = stripTrailingPunct(raw);
    if (url.length < 8 || url.length > 4096) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    output.push(url);
    if (output.length >= MAX_URLS * 2) break;
  }
  return output;
}

function classifyUrls(urls: string[]): { doc_urls: string[]; report_urls: string[] } {
  const doc_urls: string[] = [];
  const report_urls: string[] = [];
  for (const url of urls) {
    const lower = url.toLowerCase();
    if (lower.includes('docs.google.com') || lower.includes('drive.google.com')) {
      if (!doc_urls.includes(url) && doc_urls.length < MAX_URLS) doc_urls.push(url);
    } else if (
      lower.includes('read.ai') ||
      (lower.includes('sendgrid.net') && lower.includes('click'))
    ) {
      if (!report_urls.includes(url) && report_urls.length < MAX_URLS) report_urls.push(url);
    }
  }
  return { doc_urls, report_urls };
}

export function detectMeetingNotesProvider(sender: string, subject: string): MeetingNotesProvider {
  const from = sender.toLowerCase();
  const subj = subject.toLowerCase();
  if (from.includes('gemini-notes@google.com') || subj.startsWith('notas:')) return 'gemini';
  if (from.includes('read.ai') || from.includes('e.read.ai') || subj.includes('informe de la reuni')) return 'read_ai';
  return 'unknown';
}

export function extractMeetingNotes(messages: gmail_v1.Schema$Message[]): MeetingNotes {
  const empty: MeetingNotes = {
    provider: 'none',
    has_notes: false,
    doc_urls: [],
    report_urls: [],
    content_warning: 'UNTRUSTED: meeting note links originate from external email content.',
  };
  if (messages.length === 0) return empty;

  let provider: MeetingNotesProvider = 'unknown';
  let providerFound: MeetingNotesProvider | null = null;
  const rawTexts: string[] = [];

  for (const message of messages) {
    const parts: gmail_v1.Schema$MessagePart[] = [];
    walkParts(message.payload, parts);
    const sender = headerValue(message.payload?.headers, 'From');
    const subject = headerValue(message.payload?.headers, 'Subject');
    const detected = detectMeetingNotesProvider(sender, subject);
    if ((detected === 'gemini' || detected === 'read_ai') && providerFound === null) {
      providerFound = detected;
    }
    for (const part of parts) {
      if (!part.body?.data) continue;
      const mime = (part.mimeType ?? '').toLowerCase();
      if (mime !== 'text/html' && mime !== 'text/plain') continue;
      try {
        rawTexts.push(decodeBase64Url(part.body.data));
      } catch {
        continue;
      }
    }
  }

  const allUrls = extractUrlsFromText(rawTexts.join('\n'));
  const { doc_urls, report_urls } = classifyUrls(allUrls);
  const has_notes = providerFound !== null || doc_urls.length > 0 || report_urls.length > 0;

  if (!has_notes) return empty;
  provider = providerFound ?? 'unknown';

  return {
    provider,
    has_notes: true,
    doc_urls,
    report_urls,
    content_warning: empty.content_warning,
  };
}
