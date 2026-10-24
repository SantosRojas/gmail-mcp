import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../config.js';
import type { DriveClient, GmailClient, AuditLogger } from '../types/index.js';
import { tryAuditStateChange } from '../utils/logger.js';
import { buildRawMimeMessage, isHtmlBody } from '../utils/mime.js';
import { MAX_SEND_ATTACHMENT_COUNT, MAX_SEND_TOTAL_BYTES, guessMimeType } from '../utils/outgoingAttachments.js';
import { extractGoogleError, mcpError, mcpText, validateComposition, validateRecipients } from './common.js';

async function downloadDriveFile(drive: DriveClient, fileId: string, maxBytes: number) {
  const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType,size' });
  const name = (meta.data.name ?? fileId).trim() || fileId;
  const size = meta.data.size ? Number.parseInt(meta.data.size, 10) : null;
  if (size !== null && Number.isFinite(size) && size > maxBytes) {
    throw new Error(`Drive file "${name}" exceeds the per-file limit of ${maxBytes} bytes.`);
  }
  const content = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  const bytes = Buffer.from(content.data as ArrayBuffer);
  if (bytes.length > maxBytes) throw new Error(`Drive file "${name}" exceeds the per-file limit of ${maxBytes} bytes.`);
  return { filename: name, mimeType: meta.data.mimeType ?? guessMimeType(name), contentBase64: bytes.toString('base64'), bytes: bytes.length };
}

export function registerDriveSendTools(server: McpServer, gmail: GmailClient, drive: DriveClient, config: AppConfig, auditLog: AuditLogger): void {
  server.registerTool(
    'gmail_create_draft_with_drive_files',
    {
      description: 'Creates a Gmail draft attaching Google Drive files by ID (downloaded server-side, never written to disk). Max 5 files. Audited; never sends.',
      inputSchema: z.object({
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).max(100).optional(),
        bcc: z.array(z.string().email()).max(100).optional(),
        subject: z.string(),
        body: z.string(),
        drive_file_ids: z.array(z.string().min(1)).min(1).max(5).describe('Drive file IDs to attach'),
        is_html: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, cc, bcc, subject, body, drive_file_ids, is_html }) => {
      const started = Date.now();
      const reason = `create draft with ${drive_file_ids.length} Drive file(s)`;
      try {
        if (drive_file_ids.length > MAX_SEND_ATTACHMENT_COUNT) throw new Error(`Attachment count exceeds ${MAX_SEND_ATTACHMENT_COUNT}.`);
        validateRecipients([...to, ...(cc ?? []), ...(bcc ?? [])], config);
        validateComposition(subject, body, config);
        const attachments = [];
        let totalBytes = 0;
        for (const fileId of drive_file_ids) {
          const file = await downloadDriveFile(drive, fileId.trim(), config.maxSendAttachmentBytes);
          totalBytes += file.bytes;
          if (totalBytes > MAX_SEND_TOTAL_BYTES) throw new Error(`Combined attachment size exceeds ${MAX_SEND_TOTAL_BYTES} bytes.`);
          attachments.push({ filename: file.filename, mimeType: file.mimeType, contentBase64: file.contentBase64 });
        }
        const raw = buildRawMimeMessage({
          to,
          ...(cc?.length ? { cc } : {}),
          ...(bcc?.length ? { bcc } : {}),
          subject,
          body,
          attachments,
          ...(is_html !== undefined ? { isHtml: is_html } : {}),
        });
        const response = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
        const targetId = response.data.id ?? 'unknown';
        const html = is_html ?? isHtmlBody(body);
        const auditStatus = await tryAuditStateChange(auditLog, { tool_name: 'gmail_create_draft_with_drive_files', target_id: targetId, reason, status: 'success', duration_ms: Date.now() - started });
        return mcpText({
          draft_id: targetId,
          status: 'created',
          is_html: html,
          attachments: attachments.map((attachment) => ({ filename: attachment.filename, mime_type: attachment.mimeType })),
          audit_status: auditStatus,
        });
      } catch (error) {
        await tryAuditStateChange(auditLog, { tool_name: 'gmail_create_draft_with_drive_files', target_id: 'pending', reason, status: 'error', duration_ms: Date.now() - started, error: extractGoogleError(error) });
        return mcpError('Unable to create draft with Drive files', error);
      }
    },
  );
}
