import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { InlineAttachment, OutgoingAttachment } from './mime.js';

export const MAX_SEND_ATTACHMENT_COUNT = 5;
export const MAX_SEND_TOTAL_BYTES = 25_000_000;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ics': 'text/calendar',
  '.json': 'application/json',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip',
};

export function guessMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXTENSION[filename.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export interface ResolvedAttachments {
  attachments: OutgoingAttachment[];
  totalBytes: number;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Enforces ALLOWED_ATTACHMENT_DIRS when configured. Symlinks are resolved so a
 * link inside an allowed directory cannot point at a file outside it.
 */
async function assertPathAllowed(absolute: string, allowedRoots: string[] | null | undefined, kind: string): Promise<void> {
  if (!allowedRoots?.length) return;
  const target = await realpath(absolute);
  for (const root of allowedRoots) {
    try {
      if (isInside(await realpath(resolve(root)), target)) return;
    } catch {
      // Ignore non-existent roots; another configured root may still match.
    }
  }
  throw new Error(
    `${kind} "${basename(target)}" is outside ALLOWED_ATTACHMENT_DIRS. Configure the directories the server may read from.`,
  );
}

export async function resolveOutgoingAttachments(
  paths: string[],
  maxFileBytes: number,
  allowedRoots?: string[] | null,
): Promise<ResolvedAttachments> {
  if (paths.length > MAX_SEND_ATTACHMENT_COUNT) {
    throw new Error(`Attachment count exceeds the limit of ${MAX_SEND_ATTACHMENT_COUNT}.`);
  }
  const attachments: OutgoingAttachment[] = [];
  let totalBytes = 0;
  for (const input of paths) {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('Attachment path cannot be empty.');
    const absolute = resolve(trimmed);
    const info = await stat(absolute).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`Attachment not found or not a file: ${trimmed}`);
    await assertPathAllowed(absolute, allowedRoots, 'Attachment');
    if (info.size > maxFileBytes) {
      throw new Error(`Attachment "${basename(absolute)}" (${info.size} bytes) exceeds the per-file limit of ${maxFileBytes} bytes.`);
    }
    totalBytes += info.size;
    if (totalBytes > MAX_SEND_TOTAL_BYTES) {
      throw new Error(`Combined attachment size exceeds the Gmail limit of ${MAX_SEND_TOTAL_BYTES} bytes.`);
    }
    const content = await readFile(absolute);
    const filename = basename(absolute);
    attachments.push({
      filename,
      mimeType: guessMimeType(filename),
      contentBase64: content.toString('base64'),
    });
  }
  return { attachments, totalBytes };
}

export function describeAttachments(attachments: OutgoingAttachment[], totalBytes: number): string {
  const names = attachments.map((attachment) => `${attachment.filename} (${attachment.mimeType})`).join(', ');
  return `${attachments.length} attachment(s), ${totalBytes} bytes: ${names}`.slice(0, 300);
}

export interface InlineImageInput {
  path: string;
  content_id: string;
}

/** Resolves local image files to MIME inline parts referenced as cid:<content_id>. */
export async function resolveInlineImages(
  inputs: InlineImageInput[],
  maxFileBytes: number,
  allowedRoots?: string[] | null,
): Promise<InlineAttachment[]> {
  if (inputs.length > MAX_SEND_ATTACHMENT_COUNT) {
    throw new Error(`Inline image count exceeds the limit of ${MAX_SEND_ATTACHMENT_COUNT}.`);
  }
  const seen = new Set<string>();
  const resolved: InlineAttachment[] = [];
  for (const input of inputs) {
    const cid = input.content_id.trim();
    if (!cid || /[\s<>]/.test(cid)) throw new Error(`Invalid content_id "${input.content_id}". Use a simple token like "logo".`);
    if (seen.has(cid)) throw new Error(`Duplicate content_id "${cid}". Each inline image needs a unique content_id.`);
    seen.add(cid);
    const absolute = resolve(input.path.trim());
    if (!input.path.trim()) throw new Error('Inline image path cannot be empty.');
    const info = await stat(absolute).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`Inline image not found or not a file: ${input.path}`);
    await assertPathAllowed(absolute, allowedRoots, 'Inline image');
    if (info.size > maxFileBytes) throw new Error(`Inline image "${basename(absolute)}" exceeds the per-file limit of ${maxFileBytes} bytes.`);
    const content = await readFile(absolute);
    const filename = basename(absolute);
    resolved.push({ filename, mimeType: guessMimeType(filename), contentBase64: content.toString('base64'), contentId: cid });
  }
  return resolved;
}
