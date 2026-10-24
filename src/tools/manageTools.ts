import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../config.js';
import type { GmailClient, AuditLogger, TargetType } from '../types/index.js';
import { tryAuditStateChange } from '../utils/logger.js';
import { extractGoogleError, mcpError, mcpText } from './common.js';

const targetSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['message', 'thread']).default('message'),
});

function rejectProtectedLabels(labels: string[] | undefined): void {
  for (const label of labels ?? []) {
    if (label.toUpperCase() === 'TRASH') {
      throw new Error('TRASH is protected. Use gmail_trash_message with a mandatory reason.');
    }
  }
}

const SETTLED_LOCATION_LABELS = new Set(['INBOX', 'SPAM', 'TRASH', 'SENT', 'DRAFT']);

async function restoreInboxPlacement(
  gmail: GmailClient,
  id: string,
  type: TargetType,
): Promise<'inbox_restored' | 'unchanged' | 'placement_failed'> {
  try {
    let labelIds: string[] = [];
    if (type === 'message') {
      const response = await gmail.users.messages.get({ userId: 'me', id, format: 'minimal' });
      labelIds = response.data.labelIds ?? [];
    } else {
      const response = await gmail.users.threads.get({ userId: 'me', id, format: 'minimal' });
      labelIds = response.data.messages?.[0]?.labelIds ?? [];
    }
    const present = new Set(labelIds.map((label) => label.toUpperCase()));
    if ([...SETTLED_LOCATION_LABELS].some((label) => present.has(label))) return 'unchanged';

    const request = { userId: 'me' as const, id, requestBody: { addLabelIds: ['INBOX'] } };
    if (type === 'message') {
      await gmail.users.messages.modify(request);
    } else {
      await gmail.users.threads.modify(request);
    }
    return 'inbox_restored';
  } catch {
    return 'placement_failed';
  }
}

export function registerManageTools(server: McpServer, gmail: GmailClient, _config: AppConfig, auditLog: AuditLogger): void {
  server.registerTool(
    'gmail_trash_message',
    {
      description:
        'Soft-deletes a Gmail message or thread by moving it to Trash. Permanent delete APIs are intentionally unavailable.',
      inputSchema: z.object({
        id: z.string().min(1),
        type: z.enum(['message', 'thread']).default('message'),
        reason: z.string().min(3).max(500).describe('Mandatory explanation for why this item is being moved to Trash'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, type, reason }) => {
      const started = Date.now();
      try {
        if (type === 'message') {
          await gmail.users.messages.trash({ userId: 'me', id });
        } else {
          await gmail.users.threads.trash({ userId: 'me', id });
        }
        const auditStatus = await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_trash_message',
          target_id: id,
          reason,
          status: 'success',
          duration_ms: Date.now() - started,
        });
        return mcpText({ id, type, status: 'trashed', audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_trash_message',
          target_id: id,
          reason,
          status: 'error',
          duration_ms: Date.now() - started,
          error: extractGoogleError(error),
        });
        return mcpError(`Unable to move ${type} ${id} to Trash`, error);
      }
    },
  );

  server.registerTool(
    'gmail_restore_message',
    {
      description: 'Restores a Gmail message or thread from Trash using untrash.',
      inputSchema: targetSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, type }) => {
      const started = Date.now();
      try {
        if (type === 'message') {
          await gmail.users.messages.untrash({ userId: 'me', id });
        } else {
          await gmail.users.threads.untrash({ userId: 'me', id });
        }
        const placement = await restoreInboxPlacement(gmail, id, type);
        const auditStatus = await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_restore_message',
          target_id: id,
          reason: placement === 'inbox_restored' ? 'restore from Trash and return to Inbox' : 'restore from Trash',
          status: 'success',
          duration_ms: Date.now() - started,
        });
        return mcpText({ id, type, status: 'restored', placement, audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_restore_message',
          target_id: id,
          reason: 'restore from Trash',
          status: 'error',
          duration_ms: Date.now() - started,
          error: extractGoogleError(error),
        });
        return mcpError(`Unable to restore ${type} ${id}`, error);
      }
    },
  );

  server.registerTool(
    'gmail_apply_labels',
    {
      description: 'Adds and/or removes Gmail labels. TRASH is protected and can only be reached through gmail_trash_message.',
      inputSchema: z.object({
        id: z.string().min(1),
        type: z.enum(['message', 'thread']).default('message'),
        add_labels: z.array(z.string().min(1)).max(100).optional(),
        remove_labels: z.array(z.string().min(1)).max(100).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, type, add_labels, remove_labels }) => {
      const started = Date.now();
      const reason = 'label modification';
      try {
        rejectProtectedLabels(add_labels);
        rejectProtectedLabels(remove_labels);
        if ((!add_labels || add_labels.length === 0) && (!remove_labels || remove_labels.length === 0)) {
          throw new Error('At least one label must be added or removed.');
        }

        const request = {
          userId: 'me' as const,
          id,
          requestBody: {
            ...(add_labels?.length ? { addLabelIds: add_labels } : {}),
            ...(remove_labels?.length ? { removeLabelIds: remove_labels } : {}),
          },
        };

        if (type === 'message') {
          await gmail.users.messages.modify(request);
        } else {
          await gmail.users.threads.modify(request);
        }

        const auditStatus = await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_apply_labels',
          target_id: id,
          reason,
          status: 'success',
          duration_ms: Date.now() - started,
        });
        return mcpText({ id, type, add_labels: add_labels ?? [], remove_labels: remove_labels ?? [], status: 'updated', audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_apply_labels',
          target_id: id,
          reason,
          status: 'error',
          duration_ms: Date.now() - started,
          error: extractGoogleError(error),
        });
        return mcpError(`Unable to update labels for ${type} ${id}`, error);
      }
    },
  );
}
