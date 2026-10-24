import { Buffer } from 'node:buffer';

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return `=?UTF-8?B?${encoded}?=`;
}

function wrapBase64(input: string, width = 76): string {
  const parts: string[] = [];
  for (let i = 0; i < input.length; i += width) parts.push(input.slice(i, i + width));
  return parts.join('\r\n');
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export interface ReplyHeaders {
  inReplyTo?: string;
  references?: string;
}

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export interface InlineAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
  /** Content-ID referenced as cid:<contentId> from the HTML body (no brackets). */
  contentId: string;
}

function encodeAttachmentName(filename: string): string {
  if (/^[\x20-\x7e]*$/.test(filename) && !/["\\]/.test(filename)) return `"${filename}"`;
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'attachment';
  return `"${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function randomBoundary(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 24; i += 1) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `gmail-mcp-${suffix}`;
}

export function isHtmlBody(body: string): boolean {
  return /<!doctype\s+html|<\s*(html|head|body|div|table|tr|td|style|h1|h2|h3|h4|p|a|img|span|center|title|meta|link|ul|ol|li|blockquote|button|section|article)[^>]*>/i.test(body);
}

function htmlToPlainFallback(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(br|p|div|h1|h2|h3|li|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildRawMimeMessage(params: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  reply?: ReplyHeaders;
  attachments?: OutgoingAttachment[];
  inlineAttachments?: InlineAttachment[];
  isHtml?: boolean;
}): string {
  const html = params.isHtml ?? isHtmlBody(params.body);
  const inline = params.inlineAttachments ?? [];
  if (inline.length > 0 && !html) {
    throw new Error('Inline images require an HTML body (cid: references have no plain-text target).');
  }
  for (const item of inline) {
    if (!item.contentId.trim() || /[\s<>]/.test(item.contentId)) {
      throw new Error(`Invalid inline contentId: "${item.contentId}". Use a simple token like "logo".`);
    }
  }
  const bodyBase64 = wrapBase64(Buffer.from(params.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'));
  const plainFallbackBase64 = wrapBase64(
    Buffer.from(htmlToPlainFallback(params.body).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'),
  );
  const bodyContentType = html ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8';
  const head = [
    `To: ${params.to.join(', ')}`,
    ...(params.cc?.length ? [`Cc: ${params.cc.join(', ')}`] : []),
    ...(params.bcc?.length ? [`Bcc: ${params.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeader(params.subject)}`,
    ...(params.reply?.inReplyTo ? [`In-Reply-To: ${params.reply.inReplyTo}`] : []),
    ...(params.reply?.references ? [`References: ${params.reply.references}`] : []),
    'MIME-Version: 1.0',
  ];
  const alternativeSection = (altBoundary: string): string[] => [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    plainFallbackBase64,
    `--${altBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyBase64,
    `--${altBoundary}--`,
  ];

  const inlinePartLines = (item: InlineAttachment): string[] => [
    `Content-Type: ${item.mimeType}; name=${encodeAttachmentName(item.filename)}`,
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${item.contentId}>`,
    `Content-Disposition: inline; filename=${encodeAttachmentName(item.filename)}`,
    '',
    wrapBase64(item.contentBase64),
  ];

  if (!params.attachments?.length && inline.length === 0) {
    if (!html) {
      return encodeBase64Url([...head, `Content-Type: ${bodyContentType}`, 'Content-Transfer-Encoding: base64', '', bodyBase64].join('\r\n'));
    }
    const altBoundary = randomBoundary();
    return encodeBase64Url(
      [...head, `Content-Type: multipart/alternative; boundary="${altBoundary}"`, '', ...alternativeSection(altBoundary), ''].join(
        '\r\n',
      ),
    );
  }
  if (!params.attachments?.length) {
    const relBoundary = randomBoundary();
    const altBoundary = randomBoundary();
    return encodeBase64Url(
      [
        ...head,
        `Content-Type: multipart/related; boundary="${relBoundary}"`,
        '',
        `--${relBoundary}`,
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        '',
        ...alternativeSection(altBoundary),
        ...inline.flatMap((item) => [`--${relBoundary}`, ...inlinePartLines(item)]),
        `--${relBoundary}--`,
        '',
      ].join('\r\n'),
    );
  }
  const boundary = randomBoundary();
  const parts = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`];
  if (inline.length === 0) {
    if (!html) {
      parts.push(`Content-Type: ${bodyContentType}`, 'Content-Transfer-Encoding: base64', '', bodyBase64);
    } else {
      const altBoundary = randomBoundary();
      parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`, '', ...alternativeSection(altBoundary));
    }
  } else {
    const relBoundary = randomBoundary();
    const altBoundary = randomBoundary();
    parts.push(
      `Content-Type: multipart/related; boundary="${relBoundary}"`,
      '',
      `--${relBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      ...alternativeSection(altBoundary),
      ...inline.flatMap((item) => [`--${relBoundary}`, ...inlinePartLines(item)]),
      `--${relBoundary}--`,
    );
  }
  for (const attachment of params.attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name=${encodeAttachmentName(attachment.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename=${encodeAttachmentName(attachment.filename)}`,
      '',
      wrapBase64(attachment.contentBase64),
    );
  }
  parts.push(`--${boundary}--`, '');
  return encodeBase64Url(parts.join('\r\n'));
}
