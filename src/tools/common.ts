import * as z from 'zod/v4';
import type { gmail_v1 } from 'googleapis';
import type { AppConfig } from '../config.js';

export function mcpError(message: string, error?: unknown) {
  const detail = error instanceof Error ? error.message : '';
  return {
    content: [{ type: 'text' as const, text: detail ? `${message}: ${detail}` : message }],
    isError: true,
  };
}

export function mcpText(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

export function validateRecipients(recipients: string[], config: AppConfig): void {
  if (recipients.length === 0) throw new Error('At least one recipient is required.');
  if (recipients.length > config.maxRecipients) {
    throw new Error(`Recipient count exceeds MAX_RECIPIENTS=${config.maxRecipients}.`);
  }
  if (!config.allowedRecipientDomains) return;

  for (const recipient of recipients) {
    const at = recipient.lastIndexOf('@');
    const domain = at >= 0 ? recipient.slice(at + 1).toLowerCase() : '';
    if (!config.allowedRecipientDomains.has(domain)) {
      throw new Error(`Recipient domain is not allowed by ALLOWED_RECIPIENT_DOMAINS: ${domain || '(invalid)'}`);
    }
  }
}

export function validateComposition(subject: string, body: string, config: AppConfig): void {
  if (!subject.trim()) throw new Error('Subject cannot be empty.');
  if (subject.length > config.maxSubjectLength) {
    throw new Error(`Subject exceeds MAX_SUBJECT_LENGTH=${config.maxSubjectLength}.`);
  }
  if (body.length > config.maxBodyLength) {
    throw new Error(`Body exceeds MAX_BODY_LENGTH=${config.maxBodyLength}.`);
  }
}

export function extractGoogleError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'response' in error
        ? ((error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ??
          'Google API request failed')
        : 'Google API request failed';
  const message = raw.slice(0, 1000);
  if (/invalid_grant|revoked|expired/i.test(message)) {
    return `${message} (OAuth refresh token rejected — run \`npm run auth:init\` again to re-authorize.)`;
  }
  return message;
}

export function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? '';
}

export function normalizeReplySubject(subject: string): string {
  return subject.replace(/^(?:(?:re|fw|fwd):\s*)+/i, '').trim().toLocaleLowerCase();
}

export function buildReferences(latestMessage: gmail_v1.Schema$Message): { inReplyTo?: string; references?: string } {
  const headers = latestMessage.payload?.headers;
  const messageId = getHeader(headers, 'Message-ID');
  const referencesHeader = getHeader(headers, 'References');
  const refs = [referencesHeader, messageId].filter(Boolean).join(' ').trim();
  return {
    ...(messageId ? { inReplyTo: messageId } : {}),
    ...(refs ? { references: refs } : {}),
  };
}

export const emptyOptionalStringArray = z.array(z.string()).optional();
