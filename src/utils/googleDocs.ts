import type { DriveClient } from '../types/index.js';
import { truncateText } from './sanitizer.js';

const DOC_ID_PATTERN = /^[a-zA-Z0-9_-]{10,}$/;

export function parseDriveDocId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Document URL or ID cannot be empty.');
  if (DOC_ID_PATTERN.test(trimmed) && !trimmed.includes('/') && !trimmed.includes(' ')) return trimmed;
  const match = trimmed.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match?.[1]) return match[1];
  throw new Error('Invalid Google Docs URL or document ID. Expected a docs.google.com/document/d/<id> link or a bare document ID.');
}

export async function fetchDocText(
  drive: DriveClient,
  documentId: string,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  const response = await drive.files.export(
    { fileId: documentId, mimeType: 'text/plain' },
    { responseType: 'text' },
  );
  const raw = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  const cleaned = raw.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (cleaned.length <= maxChars) return { text: cleaned, truncated: false };
  return { text: truncateText(cleaned, maxChars), truncated: true };
}
