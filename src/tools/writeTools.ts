import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../config.js';
import type { GmailClient, AuditLogger } from '../types/index.js';
import { tryAuditStateChange } from '../utils/logger.js';
import { buildRawMimeMessage, isHtmlBody } from '../utils/mime.js';
import { describeAttachments, resolveInlineImages, resolveOutgoingAttachments } from '../utils/outgoingAttachments.js';
import { parseMessage } from '../utils/gmail.js';
import { truncateText } from '../utils/sanitizer.js';
import { buildReferences, extractGoogleError, mcpError, mcpText, normalizeReplySubject, validateComposition, validateRecipients } from './common.js';

const attachmentPaths = z.array(z.string().min(1)).max(5).optional().describe('Local file paths to attach (max 5, validated by size)');

const baseComposition = {
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).max(100).optional(),
  bcc: z.array(z.string().email()).max(100).optional(),
  subject: z.string(),
  body: z.string(),
  thread_id: z.string().min(1).optional(),
  attachments: attachmentPaths,
  inline_images: z
    .array(z.object({ path: z.string().min(1).describe('Local image file path'), content_id: z.string().min(1).describe('Token referenced as cid:<content_id> in the HTML') }))
    .max(5)
    .optional()
    .describe('Inline images for HTML (multipart/related with Content-ID). Requires HTML body.'),
  is_html: z
    .boolean()
    .optional()
    .describe('Force HTML (true) or plain text (false). Omit for auto-detect: HTML tags trigger multipart/alternative with plain fallback.'),
};

const draftSchema = z.object(baseComposition);

const sendSchema = z.object({ ...baseComposition, confirm_send: z.literal(true) });

async function resolveReplyHeaders(gmail: GmailClient, threadId: string, subject: string) {
  const response = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['Message-ID', 'References', 'Subject'],
  });
  const messages = response.data.messages ?? [];
  const latest = messages.at(-1);
  if (!latest) throw new Error(`Thread ${threadId} contains no messages.`);
  const latestSubject = latest.payload?.headers?.find((header) => header.name?.toLowerCase() === 'subject')?.value?.trim() ?? '';
  if (latestSubject && normalizeReplySubject(subject) !== normalizeReplySubject(latestSubject)) {
    throw new Error(
      `Subject does not match the target thread. Use subject '${latestSubject}' or send as a new message without thread_id.`,
    );
  }
  return buildReferences(latest);
}

export function registerWriteTools(server: McpServer, gmail: GmailClient, config: AppConfig, auditLog: AuditLogger): void {
  server.registerTool(
    'gmail_create_draft',
    {
      description: 'Creates a Gmail draft for human review. It never sends the message.',
      inputSchema: draftSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, cc, bcc, subject, body, thread_id, attachments, inline_images, is_html }) => {
      const started = Date.now();
      let targetId = 'pending';
      const reason = thread_id ? `create draft for thread ${thread_id}` : 'create draft';
      try {
        validateRecipients([...to, ...(cc ?? []), ...(bcc ?? [])], config);
        validateComposition(subject, body, config);
        const reply = thread_id ? await resolveReplyHeaders(gmail, thread_id, subject) : undefined;
        const resolved = attachments?.length ? await resolveOutgoingAttachments(attachments, config.maxSendAttachmentBytes, config.allowedAttachmentDirs) : undefined;
        const inline = inline_images?.length ? await resolveInlineImages(inline_images, config.maxSendAttachmentBytes, config.allowedAttachmentDirs) : undefined;
        const raw = buildRawMimeMessage({ to, ...(cc?.length ? { cc } : {}), ...(bcc?.length ? { bcc } : {}), subject, body, ...(reply ? { reply } : {}), ...(resolved ? { attachments: resolved.attachments } : {}), ...(inline ? { inlineAttachments: inline } : {}), ...(is_html !== undefined ? { isHtml: is_html } : {}) });
        const response = await gmail.users.drafts.create({
          userId: 'me',
          requestBody: {
            message: {
              raw,
              ...(thread_id ? { threadId: thread_id } : {}),
            },
          },
        });
        targetId = response.data.id ?? 'unknown';
        const html = is_html ?? isHtmlBody(body);
        const auditStatus = await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_create_draft',
          target_id: targetId,
          reason: resolved ? `${reason} [${describeAttachments(resolved.attachments, resolved.totalBytes)}]` : reason,
          status: 'success',
          duration_ms: Date.now() - started,
        });
        return mcpText({ draft_id: targetId, thread_id: response.data.message?.threadId ?? thread_id ?? null, status: 'created', is_html: html, content_type: html ? 'multipart/alternative (text/plain + text/html)' : 'text/plain', ...(resolved ? { attachments: resolved.attachments.map((attachment) => ({ filename: attachment.filename, mime_type: attachment.mimeType })) } : {}), audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_create_draft',
          target_id: targetId,
          reason,
          status: 'error',
          duration_ms: Date.now() - started,
          error: extractGoogleError(error),
        });
        return mcpError('Unable to create Gmail draft', error);
      }
    },
  );

  server.registerTool(
    'gmail_send_message_strict',
    {
      description:
        'Directly sends a Gmail message. This is the only direct-send tool and requires confirm_send=true. Supports HTML via is_html=true or auto-detect (multipart/alternative with plain fallback). Draft-first is preferred.',
      inputSchema: sendSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, cc, bcc, subject, body, thread_id, confirm_send, attachments, inline_images, is_html }) => {
      const started = Date.now();
      let targetId = 'pending';
      const reason = confirm_send === true ? 'explicit confirm_send=true' : 'send rejected without explicit confirmation';
      try {
        if (confirm_send !== true) throw new Error('confirm_send must be explicitly true to send a message.');
        validateRecipients([...to, ...(cc ?? []), ...(bcc ?? [])], config);
        validateComposition(subject, body, config);
        const reply = thread_id ? await resolveReplyHeaders(gmail, thread_id, subject) : undefined;
        const resolved = attachments?.length ? await resolveOutgoingAttachments(attachments, config.maxSendAttachmentBytes, config.allowedAttachmentDirs) : undefined;
        const inline = inline_images?.length ? await resolveInlineImages(inline_images, config.maxSendAttachmentBytes, config.allowedAttachmentDirs) : undefined;
        const html = is_html ?? isHtmlBody(body);
        const raw = buildRawMimeMessage({ to, ...(cc?.length ? { cc } : {}), ...(bcc?.length ? { bcc } : {}), subject, body, ...(reply ? { reply } : {}), ...(resolved ? { attachments: resolved.attachments } : {}), ...(inline ? { inlineAttachments: inline } : {}), ...(is_html !== undefined ? { isHtml: is_html } : {}) });
        const response = await gmail.users.messages.send({
          userId: 'me',
          requestBody: {
            raw,
            ...(thread_id ? { threadId: thread_id } : {}),
          },
        });
        targetId = response.data.id ?? 'unknown';
        const auditStatus = await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_send_message_strict',
          target_id: targetId,
          reason: resolved ? `${reason} [${describeAttachments(resolved.attachments, resolved.totalBytes)}]` : reason,
          status: 'success',
          duration_ms: Date.now() - started,
        });
        return mcpText({ message_id: targetId, thread_id: response.data.threadId ?? thread_id ?? null, status: 'sent', content_type: html ? 'multipart/alternative (text/plain + text/html)' : 'text/plain', is_html: html, ...(resolved ? { attachments: resolved.attachments.map((attachment) => ({ filename: attachment.filename, mime_type: attachment.mimeType })) } : {}), audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_send_message_strict',
          target_id: targetId,
          reason,
          status: 'error',
          duration_ms: Date.now() - started,
          error: extractGoogleError(error),
        });
        return mcpError('Gmail send blocked or failed', error);
      }
    },
  );

  server.registerTool(
    'gmail_preview_message',
    {
      description:
        'Validates composition and shows exactly what gmail_send_message_strict would send, without sending anything. Reports detected content_type (text/plain vs multipart/alternative HTML). Read-only.',
      inputSchema: z.object(baseComposition),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ to, cc, bcc, subject, body, thread_id, attachments, inline_images, is_html }) => {
      try {
        validateRecipients([...to, ...(cc ?? []), ...(bcc ?? [])], config);
        validateComposition(subject, body, config);
        const reply = thread_id ? await resolveReplyHeaders(gmail, thread_id, subject) : undefined;
        const resolved = attachments?.length ? await resolveOutgoingAttachments(attachments, config.maxSendAttachmentBytes, config.allowedAttachmentDirs) : undefined;
        const inline = inline_images?.length ? await resolveInlineImages(inline_images, config.maxSendAttachmentBytes, config.allowedAttachmentDirs) : undefined;
        const html = is_html ?? isHtmlBody(body);
        const raw = buildRawMimeMessage({ to, ...(cc?.length ? { cc } : {}), ...(bcc?.length ? { bcc } : {}), subject, body, ...(reply ? { reply } : {}), ...(resolved ? { attachments: resolved.attachments } : {}), ...(inline ? { inlineAttachments: inline } : {}), ...(is_html !== undefined ? { isHtml: is_html } : {}) });
        return mcpText({
          to,
          cc: cc ?? [],
          bcc: bcc ?? [],
          subject,
          body_chars: body.length,
          is_html: html,
          content_type: html ? (resolved?.attachments.length || inline?.length ? 'multipart/mixed > multipart/related (text/plain + text/html + inline)' : 'multipart/alternative (text/plain + text/html)') : (resolved?.attachments.length ? 'multipart/mixed (text/plain)' : 'text/plain'),
          thread_id: thread_id ?? null,
          in_reply_to: reply?.inReplyTo ?? null,
          references: reply?.references ?? null,
          raw_size_bytes: Buffer.byteLength(raw, 'utf8'),
          attachments: resolved ? resolved.attachments.map((attachment) => ({ filename: attachment.filename, mime_type: attachment.mimeType, size_bytes: Buffer.from(attachment.contentBase64, 'base64').length })) : [],
          inline_images: inline ? inline.map((item) => ({ filename: item.filename, content_id: item.contentId })) : [],
          status: 'preview_only',
          sent: false,
        });
      } catch (error) {
        return mcpError('Unable to preview Gmail message', error);
      }
    },
  );

  server.registerTool(
    'gmail_forward_message',
    {
      description:
        'Creates a draft forwarding a message with a quoted attribution block. Attachments are listed, not re-attached. Never sends; review the draft before sending.',
      inputSchema: z.object({
        message_id: z.string().min(1).describe('Gmail message ID to forward'),
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).max(100).optional(),
        bcc: z.array(z.string().email()).max(100).optional(),
        comment: z.string().max(2000).optional().describe('Intro text prepended above the forwarded content'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ message_id, to, cc, bcc, comment }) => {
      const started = Date.now();
      let targetId = 'pending';
      const reason = `forward draft of ${message_id}`;
      try {
        validateRecipients([...to, ...(cc ?? []), ...(bcc ?? [])], config);
        const source = await gmail.users.messages.get({ userId: 'me', id: message_id, format: 'full' });
        if (!source.data.id) throw new Error(`Message ${message_id} not found.`);
        const parsed = parseMessage(source.data);
        const subject = `Fwd: ${parsed.subject || '(sin asunto)'}`;
        const attachmentNote =
          parsed.attachments.length > 0
            ? `\n[Adjuntos no reenviados (${parsed.attachments.length}): ${parsed.attachments.map((attachment) => attachment.filename).join(', ')}]`
            : '';
        const intro = comment?.trim() ? `${comment.trim()}\n\n` : '';
        const body = `${intro}---------- Forwarded message ---------\nFrom: ${parsed.sender}\nDate: ${parsed.date}\nSubject: ${parsed.subject}\n\n${truncateText(parsed.body || '(sin contenido)', config.maxBodyLength)}${attachmentNote}`;
        validateComposition(subject, body, config);
        const raw = buildRawMimeMessage({
          to,
          ...(cc?.length ? { cc } : {}),
          ...(bcc?.length ? { bcc } : {}),
          subject,
          body,
        });
        const response = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
        targetId = response.data.id ?? 'unknown';
        const auditStatus = await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_forward_message',
          target_id: targetId,
          reason,
          status: 'success',
          duration_ms: Date.now() - started,
        });
        return mcpText({ draft_id: targetId, subject, status: 'drafted', audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_forward_message',
          target_id: targetId,
          reason,
          status: 'error',
          duration_ms: Date.now() - started,
          error: extractGoogleError(error),
        });
        return mcpError('Unable to create forward draft', error);
      }
    },
  );
}
