import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRawMimeMessage } from '../src/utils/mime.js';
import { buildQuotedReply } from '../src/utils/quote.js';
import { listTemplates, renderTemplate } from '../src/utils/templates.js';
import { queryAuditLog } from '../src/utils/auditQuery.js';
import { resolveInlineImages } from '../src/utils/outgoingAttachments.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'gmail-extended-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('quoted reply', () => {
  it('prefixes Re: once and quotes lines with attribution', () => {
    const reply = buildQuotedReply({
      originalSubject: 'Factura',
      originalSender: 'boss@company.com',
      originalDate: 'Mon, 01 Jan 2024',
      originalBody: 'Hola\nMundo',
      comment: 'Revisado.',
      maxBodyChars: 200000,
    });
    expect(reply.subject).toBe('Re: Factura');
    expect(reply.body).toContain('Revisado.');
    expect(reply.body).toContain('> Hola');
    expect(reply.body).toContain('boss@company.com');
  });

  it('does not duplicate Re: prefixes', () => {
    const reply = buildQuotedReply({
      originalSubject: 'Re: Factura',
      originalSender: 'a@x.com',
      originalDate: '',
      originalBody: 'x',
      maxBodyChars: 200000,
    });
    expect(reply.subject).toBe('Re: Factura');
  });
});

describe('templates', () => {
  it('lists built-in templates and renders variables', () => {
    const templates = listTemplates();
    expect(templates.map((entry) => entry.name)).toContain('felicitacion');
    const rendered = renderTemplate('felicitacion', { nombre: 'Ana' });
    expect(rendered.body).toContain('Ana');
    expect(rendered.body).not.toContain('{{nombre}}');
  });

  it('keeps unknown placeholders and rejects unknown templates', () => {
    const rendered = renderTemplate('reunion', { tema: 'QBR' });
    expect(rendered.subject).toContain('QBR');
    expect(rendered.body).toContain('{{fecha}}');
    expect(() => renderTemplate('inexistente')).toThrow();
  });
});

describe('audit query', () => {
  it('filters by tool, status and search text', async () => {
    const file = join(tempDir, 'audit.log');
    const lines = [
      { timestamp: '2026-01-01T00:00:00.000Z', tool_name: 'gmail_send_message_strict', target_id: 'a', reason: 'ok', status: 'success' },
      { timestamp: '2026-01-01T00:01:00.000Z', tool_name: 'gmail_trash_message', target_id: 'b', reason: 'spam promo', status: 'success' },
      { timestamp: '2026-01-01T00:02:00.000Z', tool_name: 'gmail_trash_message', target_id: 'c', reason: 'fail', status: 'error', error: 'boom' },
    ];
    await writeFile(file, `${lines.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const byTool = await queryAuditLog(file, { tool_name: 'gmail_trash_message' });
    expect(byTool.total_scanned).toBe(3);
    expect(byTool.count).toBe(2);
    const errors = await queryAuditLog(file, { status: 'error' });
    expect(errors.entries[0]?.target_id).toBe('c');
    const search = await queryAuditLog(file, { search: 'promo' });
    expect(search.count).toBe(1);
  });

  it('returns empty when the log does not exist and skips bad lines', async () => {
    const missing = await queryAuditLog(join(tempDir, 'nope.log'));
    expect(missing).toEqual({ total_scanned: 0, count: 0, entries: [] });
    const file = join(tempDir, 'audit.log');
    await writeFile(file, 'not-json\n{"timestamp":"t","tool_name":"x","target_id":"y","reason":"z","status":"success"}\n');
    const result = await queryAuditLog(file);
    expect(result.total_scanned).toBe(1);
  });
});

describe('inline images', () => {
  it('emits multipart/related with Content-ID for inline-only HTML', () => {
    const decoded = decodeRaw(
      buildRawMimeMessage({
        to: ['a@x.com'],
        subject: 's',
        body: '<p>Hola <img src="cid:logo"></p>',
        isHtml: true,
        inlineAttachments: [{ filename: 'logo.png', mimeType: 'image/png', contentBase64: Buffer.from('img').toString('base64'), contentId: 'logo' }],
      }),
    );
    expect(decoded).toContain('multipart/related');
    expect(decoded).toContain('Content-ID: <logo>');
    expect(decoded).toContain('Content-Disposition: inline');
    expect(decoded).toContain('multipart/alternative');
  });

  it('rejects inline images with plain-text bodies and bad content ids', () => {
    expect(() =>
      buildRawMimeMessage({
        to: ['a@x.com'],
        subject: 's',
        body: 'plano',
        isHtml: false,
        inlineAttachments: [{ filename: 'a.png', mimeType: 'image/png', contentBase64: 'eA==', contentId: 'logo' }],
      }),
    ).toThrow(/HTML/);
    expect(() =>
      buildRawMimeMessage({
        to: ['a@x.com'],
        subject: 's',
        body: '<p>x</p>',
        isHtml: true,
        inlineAttachments: [{ filename: 'a.png', mimeType: 'image/png', contentBase64: 'eA==', contentId: 'bad id' }],
      }),
    ).toThrow(/contentId/);
  });

  it('resolves local files and rejects duplicates', async () => {
    const first = join(tempDir, 'a.png');
    const second = join(tempDir, 'b.png');
    await writeFile(first, 'img-a');
    await writeFile(second, 'img-b');
    const resolved = await resolveInlineImages(
      [
        { path: first, content_id: 'logo' },
        { path: second, content_id: 'banner' },
      ],
      10_000_000,
    );
    expect(resolved.map((item) => item.contentId)).toEqual(['logo', 'banner']);
    await expect(resolveInlineImages([{ path: first, content_id: 'logo' }, { path: second, content_id: 'logo' }], 10_000_000)).rejects.toThrow(/Duplicate/);
    await expect(resolveInlineImages([{ path: join(tempDir, 'missing.png'), content_id: 'x' }], 10_000_000)).rejects.toThrow(/not found/);
  });
});
