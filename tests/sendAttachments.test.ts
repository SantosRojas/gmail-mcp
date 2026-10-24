import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { buildRawMimeMessage } from '../src/utils/mime.js';
import { guessMimeType, resolveOutgoingAttachments } from '../src/utils/outgoingAttachments.js';
import { registerWriteTools } from '../src/tools/writeTools.js';
import type { AppConfig } from '../src/config.js';
import type { GmailClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('multipart mime with attachments', () => {
  it('keeps plain single-part output when no attachments are given', () => {
    const decoded = decodeRaw(buildRawMimeMessage({ to: ['a@x.com'], subject: 's', body: 'b' }));
    expect(decoded).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(decoded).not.toContain('multipart/mixed');
  });

  it('builds a multipart body with decodable attachment content', () => {
    const content = Buffer.from('contenido del checklist', 'utf8').toString('base64');
    const decoded = decodeRaw(
      buildRawMimeMessage({
        to: ['a@x.com'],
        subject: 'Checklist',
        body: 'va adjunto',
        attachments: [{ filename: 'checklist.md', mimeType: 'text/markdown', contentBase64: content }],
      }),
    );
    expect(decoded).toContain('multipart/mixed');
    expect(decoded).toContain('filename="checklist.md"');
    expect(decoded).toContain('Content-Type: text/markdown');
    const part = decoded.split('Content-Disposition: attachment')[1] ?? '';
    const payload = part.split('\r\n\r\n')[1]?.split('\r\n--')[0]?.replace(/\r\n/g, '') ?? '';
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('contenido del checklist');
  });

  it('encodes non-ASCII filenames without breaking headers', () => {
    const decoded = decodeRaw(
      buildRawMimeMessage({
        to: ['a@x.com'],
        subject: 's',
        body: 'b',
        attachments: [{ filename: 'Reunión despliegue.md', mimeType: 'text/markdown', contentBase64: 'eA==' }],
      }),
    );
    expect(decoded).toContain('filename*=');
    expect(decoded.split('\r\n').every((line) => /^[\x20-\x7e]*$/.test(line))).toBe(true);
  });
});

describe('outgoing attachment resolver', () => {
  function tmpFile(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-mcp-'));
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it('resolves real files with guessed mime types', async () => {
    const path = tmpFile('checklist.md', '# hola');
    const resolved = await resolveOutgoingAttachments([path], 10_000_000);
    expect(resolved.attachments).toHaveLength(1);
    expect(resolved.attachments[0]).toMatchObject({ filename: 'checklist.md', mimeType: 'text/markdown' });
    expect(Buffer.from(resolved.attachments[0]?.contentBase64 ?? '', 'base64').toString('utf8')).toBe('# hola');
  });

  it('rejects missing files, oversize payloads and too many files', async () => {
    await expect(resolveOutgoingAttachments(['/no/existe.txt'], 10_000_000)).rejects.toThrow(/not found/);
    const big = tmpFile('big.bin', 'x'.repeat(100));
    await expect(resolveOutgoingAttachments([big], 10)).rejects.toThrow(/exceeds/);
    const six = Array.from({ length: 6 }, (_, i) => tmpFile(`f${i}.txt`, 'x'));
    await expect(resolveOutgoingAttachments(six, 10_000_000)).rejects.toThrow(/count exceeds/);
  });

  it('enforces ALLOWED_ATTACHMENT_DIRS when configured', async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), 'gmail-mcp-root-'));
    const inside = join(allowedRoot, 'inside.txt');
    writeFileSync(inside, 'ok');
    await expect(resolveOutgoingAttachments([inside], 10_000_000, [allowedRoot])).resolves.toMatchObject({
      attachments: [{ filename: 'inside.txt' }],
    });

    const outside = tmpFile('outside.txt', 'secret');
    await expect(resolveOutgoingAttachments([outside], 10_000_000, [allowedRoot])).rejects.toThrow(
      /outside ALLOWED_ATTACHMENT_DIRS/,
    );
  });

  it('guesses common mime types and falls back safely', () => {
    expect(guessMimeType('a.pdf')).toBe('application/pdf');
    expect(guessMimeType('a.XLSX')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(guessMimeType('sin-extension')).toBe('application/octet-stream');
  });
});

describe('send with attachments (handler)', () => {
  type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

  function handlers(sent: { raws: string[] }): Map<string, ToolHandler> {
    const handlers = new Map<string, ToolHandler>();
    const server = { registerTool: (name: string, _meta: unknown, handler: ToolHandler) => handlers.set(name, handler) };
    const gmail = {
      users: {
        messages: { send: vi.fn(async (params: { requestBody: { raw: string } }) => { sent.raws.push(params.requestBody.raw); return { data: { id: 'm1', threadId: 't1' } }; }) },
        drafts: { create: vi.fn(async () => ({ data: { id: 'd1', message: { threadId: 't1' } } })) },
        threads: { get: vi.fn(async () => { throw new Error('no threads in this harness'); }) },
      },
    } as unknown as GmailClient;
    const auditLog = { write: vi.fn(async () => {}) };
    registerWriteTools(server as unknown as McpServer, gmail, { maxRecipients: 20, maxAttachmentBytes: 1_000_000, maxSendAttachmentBytes: 10_000_000, maxSubjectLength: 998, maxBodyLength: 200_000, maxMessageBodyChars: 20_000, maxThreadBodyChars: 60_000 } as AppConfig, auditLog as never);
    return handlers;
  }

  function parseText(result: { content: Array<{ text: string }> }): Record<string, any> {
    return JSON.parse(result.content[0]?.text ?? '{}');
  }

  it('sends multipart raw and reports attachment metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-mcp-'));
    const path = join(dir, 'Checklist.md');
    writeFileSync(path, '# checklist');
    const sent = { raws: [] as string[] };
    const result = await handlers(sent).get('gmail_send_message_strict')?.({
      to: ['a@x.com'],
      subject: 's',
      body: 'b',
      attachments: [path],
      confirm_send: true,
    });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.status).toBe('sent');
    expect(body.attachments).toEqual([{ filename: 'Checklist.md', mime_type: 'text/markdown' }]);
    expect(decodeRaw(sent.raws[0] ?? '')).toContain('multipart/mixed');
  });

  it('blocks invalid attachment paths before calling Gmail', async () => {
    const sent = { raws: [] as string[] };
    const result = await handlers(sent).get('gmail_send_message_strict')?.({
      to: ['a@x.com'],
      subject: 's',
      body: 'b',
      attachments: ['/no/existe.md'],
      confirm_send: true,
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(sent.raws).toHaveLength(0);
  });
});
