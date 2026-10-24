import { normalizePlainText, truncateText } from './sanitizer.js';

export interface QuotedReply {
  subject: string;
  body: string;
}

/**
 * Builds a reply subject/body quoting the original message.
 * Pure function: no I/O, fully unit-testable.
 */
export function buildQuotedReply(params: {
  originalSubject: string;
  originalSender: string;
  originalDate: string;
  originalBody: string;
  comment?: string;
  maxBodyChars: number;
}): QuotedReply {
  const subject = /^\s*re:/i.test(params.originalSubject) ? params.originalSubject.trim() : `Re: ${params.originalSubject.trim() || '(sin asunto)'}`;
  const quoted = normalizePlainText(params.originalBody || '(sin contenido)')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const attribution = `El ${params.originalDate || '(fecha desconocida)'}, ${params.originalSender || '(remitente desconocido)'} escribió:`;
  const intro = params.comment?.trim() ? `${params.comment.trim()}\n\n` : '';
  const body = truncateText(`${intro}${attribution}\n${quoted}`, params.maxBodyChars);
  return { subject, body };
}
