import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlToSafeMarkdown, normalizePlainText, truncateText, collapseInvisibleNoise, shortenLongUrls } from '../src/utils/sanitizer.js';
import { buildRawMimeMessage, isHtmlBody } from '../src/utils/mime.js';
import { JsonlAuditLogger } from '../src/utils/logger.js';
import { buildReferences, extractGoogleError, normalizeReplySubject } from '../src/tools/common.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'gmail-secure-mcp-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('sanitizer', () => {
  it('removes active HTML and unsafe markdown link schemes', () => {
    const markdown = htmlToSafeMarkdown('<script>alert(1)</script><p>Hello <a href="javascript:alert(1)">world</a></p>');
    expect(markdown).toContain('Hello world');
    expect(markdown).not.toContain('javascript:');
  });

  it('normalizes text and truncates with a marker', () => {
    expect(normalizePlainText(' a\r\nb\u0000 ')).toBe('a\nb');
    expect(truncateText('abcdef', 3)).toContain('[CONTENIDO TRUNCADO');
  });

  it('strips zero-width and format characters that bloat model context', () => {
    expect(collapseInvisibleNoise('a\u200B\u200C\u200Db')).toBe('ab');
    expect(collapseInvisibleNoise('a\u200B \u2060\u00ADb')).toBe('a b');
    expect(htmlToSafeMarkdown('<p>Ecosistema:\u200C \u200C \u200C fin</p>')).toBe('Ecosistema: fin');
  });

  it('collapses long whitespace runs outside fenced code blocks', () => {
    expect(normalizePlainText('a      b')).toBe('a b');
    expect(normalizePlainText('a\u00A0\u00A0\u00A0b')).toBe('a b');
    const fenced = '```\ncode   with   spaces\n```';
    expect(collapseInvisibleNoise(fenced)).toBe(fenced);
  });

  it('shortens tracker-bloated URLs while preserving host provenance', () => {
    const longUrl = `https://t6.pe.email.samsung.com/r/?id=${'x'.repeat(300)}`;
    const shortened = shortenLongUrls(`mira [ver online](${longUrl}) y esto`);
    expect(shortened).toContain('[ver online]');
    expect(shortened).toContain('t6.pe.email.samsung.com');
    expect(shortened).not.toContain('x'.repeat(300));
    expect(shortened).toContain('chars]');
    expect(shortenLongUrls('unete https://meet.google.com/yym-zyqs-rvr listo')).toContain(
      'https://meet.google.com/yym-zyqs-rvr',
    );
  });

  it('keeps balanced parentheses inside long URLs and preserves markdown syntax', () => {
    const longWithParens = `https://example.com/a(b)c/${'y'.repeat(300)}`;
    const shortened = shortenLongUrls(`mira [docs](${longWithParens}) fin`);
    expect(shortened).toContain('[docs](');
    expect(shortened.endsWith(') fin')).toBe(true);
    expect(shortened).not.toContain('y'.repeat(300));
    expect(shortenLongUrls('ver (https://example.com/corta) ya')).toContain('(https://example.com/corta)');
  });
});

describe('mime builder', () => {
  it('creates base64url MIME and reply headers', () => {
    const raw = buildRawMimeMessage({
      to: ['user@example.com'],
      subject: 'Re: Asunto',
      body: 'Hola ñ',
      reply: { inReplyTo: '<abc@example.com>', references: '<abc@example.com>' },
    });
    expect(raw).not.toMatch(/[+/=]/);
  });

  it('emits Cc/Bcc headers only when provided', () => {
    const withCopies = Buffer.from(
      buildRawMimeMessage({ to: ['a@x.com'], cc: ['b@x.com', 'c@x.com'], bcc: ['d@x.com'], subject: 's', body: 'b' }),
      'base64url',
    ).toString('utf8');
    expect(withCopies).toContain('Cc: b@x.com, c@x.com');
    expect(withCopies).toContain('Bcc: d@x.com');

    const withoutCopies = Buffer.from(
      buildRawMimeMessage({ to: ['a@x.com'], subject: 's', body: 'b' }),
      'base64url',
    ).toString('utf8');
    expect(withoutCopies).not.toContain('Cc:');
    expect(withoutCopies).not.toContain('Bcc:');
  });

  it('detects HTML including doctype/head/meta and builds multipart/alternative', () => {
    expect(isHtmlBody('<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body><p>Hola</p></body></html>')).toBe(true);
    expect(isHtmlBody('Hola mundo')).toBe(false);
    const decoded = Buffer.from(
      buildRawMimeMessage({ to: ['a@x.com'], subject: 's', body: '<!DOCTYPE html><html><body><p>Hola</p></body></html>' }),
      'base64url',
    ).toString('utf8');
    expect(decoded).toContain('multipart/alternative');
    expect(decoded).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(decoded).toContain('Content-Type: text/html; charset=UTF-8');
  });

  it('respects explicit isHtml override over auto-detect', () => {
    const forcedHtml = Buffer.from(
      buildRawMimeMessage({ to: ['a@x.com'], subject: 's', body: 'texto plano', isHtml: true }),
      'base64url',
    ).toString('utf8');
    expect(forcedHtml).toContain('multipart/alternative');
    const forcedPlain = Buffer.from(
      buildRawMimeMessage({ to: ['a@x.com'], subject: 's', body: '<p>Hola</p>', isHtml: false }),
      'base64url',
    ).toString('utf8');
    expect(forcedPlain).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(forcedPlain).not.toContain('multipart/alternative');
  });

  it('nests multipart/alternative inside multipart/mixed for HTML with attachments', () => {
    const decoded = Buffer.from(
      buildRawMimeMessage({
        to: ['a@x.com'],
        subject: 's',
        body: '<p>Hola</p>',
        isHtml: true,
        attachments: [{ filename: 'a.txt', mimeType: 'text/plain', contentBase64: Buffer.from('x').toString('base64') }],
      }),
      'base64url',
    ).toString('utf8');
    expect(decoded).toContain('multipart/mixed');
    expect(decoded).toContain('multipart/alternative');
    expect(decoded).toContain('Content-Type: text/html; charset=UTF-8');
  });
});

describe('reply metadata', () => {
  it('normalizes common reply prefixes', () => {
    expect(normalizeReplySubject('Re: Fwd: Factura')).toBe('factura');
  });

  it('builds References from prior references plus Message-ID', () => {
    const result = buildReferences({
      id: 'm1',
      payload: {
        headers: [
          { name: 'Message-ID', value: '<m1@example.com>' },
          { name: 'References', value: '<m0@example.com>' },
        ],
      },
    });
    expect(result.inReplyTo).toBe('<m1@example.com>');
    expect(result.references).toBe('<m0@example.com> <m1@example.com>');
  });

  it('maps revoked-token errors to a re-auth hint', () => {
    expect(extractGoogleError({ response: { data: { error: { message: 'invalid_grant: Token has been expired or revoked.' } } } })).toContain(
      'npm run auth:init',
    );
    expect(extractGoogleError(new Error('boom'))).toBe('boom');
  });
});

describe('audit logger', () => {
  it('writes one JSON object per line and serializes concurrent writes', async () => {
    const file = join(tempDir, 'audit.log');
    const logger = new JsonlAuditLogger(file);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        logger.write({
          timestamp: new Date().toISOString(),
          tool_name: 'test',
          target_id: String(index),
          reason: 'reason\nwith newlines',
          status: 'success',
        }),
      ),
    );
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(10);
    for (const line of lines) {
      const entry = JSON.parse(line) as { reason: string };
      expect(entry.reason).toBe('reason with newlines');
    }
  });

  it('rotates the log past the byte limit without losing entries', async () => {
    const file = join(tempDir, 'audit.log');
    const logger = new JsonlAuditLogger(file, 400);
    for (let index = 0; index < 5; index++) {
      await logger.write({
        timestamp: new Date().toISOString(),
        tool_name: 'test',
        target_id: `target-${index}-padding-to-grow-each-line`,
        reason: 'reason',
        status: 'success',
      });
    }
    const rotated = await readFile(`${file}.1`, 'utf8');
    const current = await readFile(file, 'utf8');
    const entries = `${rotated.trim()}\n${current.trim()}`
      .split('\n')
      .map((line) => JSON.parse(line) as { target_id: string });
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.target_id)).toContain('target-0-padding-to-grow-each-line');
  });
});
