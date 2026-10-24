import { describe, expect, it } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import {
  detectMeetingNotesProvider,
  extractMeetingNotes,
  extractUrlsFromText,
} from '../src/utils/meetingNotes.js';

function encode(data: string): string {
  return Buffer.from(data, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function message(opts: {
  id: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
}): gmail_v1.Schema$Message {
  const parts: gmail_v1.Schema$MessagePart[] = [];
  if (opts.text) {
    parts.push({ mimeType: 'text/plain', body: { data: encode(opts.text) } });
  }
  if (opts.html) {
    parts.push({ mimeType: 'text/html', body: { data: encode(opts.html) } });
  }
  return {
    id: opts.id,
    threadId: 't1',
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: opts.from },
        { name: 'Subject', value: opts.subject },
      ],
      parts,
    },
  };
}

describe('detectMeetingNotesProvider', () => {
  it('detects Gemini notes by sender', () => {
    expect(detectMeetingNotesProvider('Gemini <gemini-notes@google.com>', 'Notas: Mr IA')).toBe('gemini');
  });

  it('detects Read AI by sender and subject', () => {
    expect(
      detectMeetingNotesProvider('Alex via Read AI <executiveassistant@e.read.ai>', 'Informe de la Reunión'),
    ).toBe('read_ai');
  });

  it('returns unknown for regular mail', () => {
    expect(detectMeetingNotesProvider('a@example.com', 'Hola')).toBe('unknown');
  });
});

describe('extractUrlsFromText', () => {
  it('dedupes and strips trailing punctuation', () => {
    const urls = extractUrlsFromText('ver https://docs.google.com/document/d/abc123/edit, y otra vez https://docs.google.com/document/d/abc123/edit.');
    expect(urls).toEqual(['https://docs.google.com/document/d/abc123/edit']);
  });

  it('handles parens balance', () => {
    const urls = extractUrlsFromText('(ver https://read.ai/meet/xyz)');
    expect(urls).toEqual(['https://read.ai/meet/xyz']);
  });
});

describe('extractMeetingNotes', () => {
  it('returns none for empty threads', () => {
    const notes = extractMeetingNotes([]);
    expect(notes).toMatchObject({ provider: 'none', has_notes: false, doc_urls: [], report_urls: [] });
  });

  it('extracts a Google Doc link from a Gemini notes mail', () => {
    const notes = extractMeetingNotes([
      message({
        id: 'm1',
        from: 'Gemini <gemini-notes@google.com>',
        subject: 'Notas: Mr IA, 18 sept 2026',
        html: '<a href="https://docs.google.com/document/d/1AbC123/edit">Abrir notas de la reunión</a>',
      }),
    ]);
    expect(notes.provider).toBe('gemini');
    expect(notes.has_notes).toBe(true);
    expect(notes.doc_urls).toEqual(['https://docs.google.com/document/d/1AbC123/edit']);
  });

  it('extracts a Read AI report link from raw HTML before sanitizer truncation', () => {
    const longUrl = `https://u25608997.ct.sendgrid.net/ls/click?upn=${'a'.repeat(200)}`;
    const notes = extractMeetingNotes([
      message({
        id: 'm2',
        from: 'Alex via Read AI <executiveassistant@e.read.ai>',
        subject: 'Informe de la Reunión',
        html: `<p>Ver Informe <a href="${longUrl}">aqui</a></p>`,
      }),
    ]);
    expect(notes.provider).toBe('read_ai');
    expect(notes.has_notes).toBe(true);
    expect(notes.report_urls).toHaveLength(1);
    expect(notes.report_urls[0]).toContain('sendgrid.net');
    expect(notes.report_urls[0]?.length).toBeGreaterThan(160);
  });

  it('returns none for regular mail without note links', () => {
    const notes = extractMeetingNotes([
      message({ id: 'm3', from: 'a@example.com', subject: 'Hola', text: 'sin links de reunion' }),
    ]);
    expect(notes.has_notes).toBe(false);
    expect(notes.provider).toBe('none');
  });
});
