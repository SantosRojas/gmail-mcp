import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../config.js';
import type { GmailClient, AuditLogger } from '../types/index.js';
import { tryAuditStateChange } from '../utils/logger.js';
import { queryAuditLog } from '../utils/auditQuery.js';
import { extractGoogleError, mcpError, mcpText } from './common.js';

const idList = z.array(z.string().min(1)).min(1).max(25).describe('Target IDs (max 25 per call)');

async function eachBounded<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += limit) {
    await Promise.all(items.slice(index, index + limit).map(task));
  }
}

export function registerOrganizeTools(server: McpServer, gmail: GmailClient, config: AppConfig, auditLog: AuditLogger): void {
  server.registerTool(
    'gmail_batch_trash',
    {
      description: 'Soft-deletes up to 25 messages/threads in one call (reversible via restore). Requires a reason. Single audit entry with per-item results.',
      inputSchema: z.object({
        ids: idList,
        type: z.enum(['message', 'thread']).default('message'),
        reason: z.string().min(3).max(500),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ ids, type, reason }) => {
      const started = Date.now();
      const results: Array<{ id: string; status: string }> = [];
      await eachBounded(ids, 5, async (id) => {
        try {
          if (type === 'message') await gmail.users.messages.trash({ userId: 'me', id });
          else await gmail.users.threads.trash({ userId: 'me', id });
          results.push({ id, status: 'trashed' });
        } catch {
          results.push({ id, status: 'error' });
        }
      });
      const ok = results.filter((entry) => entry.status === 'trashed').length;
      const auditStatus = await tryAuditStateChange(auditLog, {
        tool_name: 'gmail_batch_trash',
        target_id: `${ids.length} ids (${ok} ok)`,
        reason,
        status: ok === ids.length ? 'success' : 'error',
        duration_ms: Date.now() - started,
        ...(ok === ids.length ? {} : { error: `${ids.length - ok} item(s) failed` }),
      });
      return mcpText({ type, total: ids.length, trashed: ok, failed: ids.length - ok, results, audit_status: auditStatus });
    },
  );

  server.registerTool(
    'gmail_batch_modify_labels',
    {
      description: 'Applies label changes to up to 25 messages/threads. TRASH stays protected (use trash tools). Single audit entry.',
      inputSchema: z.object({
        ids: idList,
        type: z.enum(['message', 'thread']).default('message'),
        add_labels: z.array(z.string().min(1)).max(100).optional(),
        remove_labels: z.array(z.string().min(1)).max(100).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ ids, type, add_labels, remove_labels }) => {
      const started = Date.now();
      const reason = 'batch label modification';
      try {
        for (const label of [...(add_labels ?? []), ...(remove_labels ?? [])]) {
          if (label.toUpperCase() === 'TRASH') throw new Error('TRASH is protected. Use gmail_trash_message / gmail_batch_trash.');
        }
        if ((!add_labels || add_labels.length === 0) && (!remove_labels || remove_labels.length === 0)) {
          throw new Error('At least one label must be added or removed.');
        }
        const results: Array<{ id: string; status: string }> = [];
        await eachBounded(ids, 5, async (id) => {
          try {
            const request = {
              userId: 'me' as const,
              id,
              requestBody: {
                ...(add_labels?.length ? { addLabelIds: add_labels } : {}),
                ...(remove_labels?.length ? { removeLabelIds: remove_labels } : {}),
              },
            };
            if (type === 'message') await gmail.users.messages.modify(request);
            else await gmail.users.threads.modify(request);
            results.push({ id, status: 'updated' });
          } catch {
            results.push({ id, status: 'error' });
          }
        });
        const ok = results.filter((entry) => entry.status === 'updated').length;
        const auditStatus = await tryAuditStateChange(auditLog, {
          tool_name: 'gmail_batch_modify_labels',
          target_id: `${ids.length} ids (${ok} ok)`,
          reason,
          status: ok === ids.length ? 'success' : 'error',
          duration_ms: Date.now() - started,
        });
        return mcpText({ type, total: ids.length, updated: ok, failed: ids.length - ok, results, audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, { tool_name: 'gmail_batch_modify_labels', target_id: `${ids.length} ids`, reason, status: 'error', duration_ms: Date.now() - started, error: extractGoogleError(error) });
        return mcpError('Unable to batch-modify labels', error);
      }
    },
  );

  const spamTarget = z.object({ id: z.string().min(1), type: z.enum(['message', 'thread']).default('message') });

  server.registerTool(
    'gmail_mark_spam',
    {
      description: 'Reports a message/thread as spam (adds SPAM, removes INBOX). Reversible via gmail_unmark_spam. Audited with reason.',
      inputSchema: spamTarget.extend({ reason: z.string().min(3).max(500).default('user-reported spam') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, type, reason }) => {
      const started = Date.now();
      try {
        const request = { userId: 'me' as const, id, requestBody: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } };
        if (type === 'message') await gmail.users.messages.modify(request);
        else await gmail.users.threads.modify(request);
        const auditStatus = await tryAuditStateChange(auditLog, { tool_name: 'gmail_mark_spam', target_id: id, reason, status: 'success', duration_ms: Date.now() - started });
        return mcpText({ id, type, status: 'marked_spam', audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, { tool_name: 'gmail_mark_spam', target_id: id, reason, status: 'error', duration_ms: Date.now() - started, error: extractGoogleError(error) });
        return mcpError(`Unable to mark ${type} ${id} as spam`, error);
      }
    },
  );

  server.registerTool(
    'gmail_unmark_spam',
    {
      description: 'Removes the SPAM label (not-spam). Audited.',
      inputSchema: spamTarget,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, type }) => {
      const started = Date.now();
      const reason = 'not spam';
      try {
        const request = { userId: 'me' as const, id, requestBody: { removeLabelIds: ['SPAM'] } };
        if (type === 'message') await gmail.users.messages.modify(request);
        else await gmail.users.threads.modify(request);
        const auditStatus = await tryAuditStateChange(auditLog, { tool_name: 'gmail_unmark_spam', target_id: id, reason, status: 'success', duration_ms: Date.now() - started });
        return mcpText({ id, type, status: 'unmarked_spam', audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, { tool_name: 'gmail_unmark_spam', target_id: id, reason, status: 'error', duration_ms: Date.now() - started, error: extractGoogleError(error) });
        return mcpError(`Unable to unmark ${type} ${id} as spam`, error);
      }
    },
  );

  server.registerTool(
    'gmail_list_filters',
    {
      description: 'Lists Gmail filter definitions (criteria + actions). Read-only.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const response = await gmail.users.settings.filters.list({ userId: 'me' });
        return mcpText({
          count: (response.data.filter ?? []).length,
          filters: (response.data.filter ?? []).map((filter) => ({ id: filter.id ?? '', criteria: filter.criteria ?? {}, action: filter.action ?? {} })),
        });
      } catch (error) {
        return mcpError('Unable to list Gmail filters', extractGoogleError(error));
      }
    },
  );

  const filterCriteria = z
    .object({
      from: z.string().max(500).optional(),
      to: z.string().max(500).optional(),
      subject: z.string().max(500).optional(),
      query: z.string().max(1000).optional(),
      has_attachment: z.boolean().optional(),
    })
    .refine((value) => value.from ?? value.to ?? value.subject ?? value.query ?? value.has_attachment !== undefined, {
      message: 'At least one filter criterion is required.',
    });

  const filterAction = z
    .object({
      add_labels: z.array(z.string().min(1)).max(20).optional(),
      remove_labels: z.array(z.string().min(1)).max(20).optional(),
      forward_to: z.string().email().optional(),
    })
    .refine((value) => value.add_labels?.length ?? value.remove_labels?.length ?? value.forward_to, {
      message: 'At least one filter action is required.',
    });

  server.registerTool(
    'gmail_create_filter',
    {
      description: 'Creates a Gmail filter (criteria + actions). Audited.',
      inputSchema: z.object({ criteria: filterCriteria, action: filterAction }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ criteria, action }) => {
      const started = Date.now();
      const reason = 'create filter';
      try {
        // A filter that adds/removes TRASH would bypass the soft-delete guardrail:
        // every trash move must go through an audited trash tool with a reason.
        for (const label of [...(action.add_labels ?? []), ...(action.remove_labels ?? [])]) {
          if (label.toUpperCase() === 'TRASH') {
            throw new Error('TRASH is protected. Filters cannot add or remove TRASH; use gmail_trash_message.');
          }
        }
        const response = await gmail.users.settings.filters.create({
          userId: 'me',
          requestBody: {
            criteria: {
              ...(criteria.from ? { from: criteria.from } : {}),
              ...(criteria.to ? { to: criteria.to } : {}),
              ...(criteria.subject ? { subject: criteria.subject } : {}),
              ...(criteria.query ? { query: criteria.query } : {}),
              ...(criteria.has_attachment !== undefined ? { hasAttachment: criteria.has_attachment } : {}),
            },
            action: {
              ...(action.add_labels?.length ? { addLabelIds: action.add_labels } : {}),
              ...(action.remove_labels?.length ? { removeLabelIds: action.remove_labels } : {}),
              ...(action.forward_to ? { forwardTo: action.forward_to } : {}),
            },
          },
        });
        const targetId = response.data.id ?? 'unknown';
        const auditStatus = await tryAuditStateChange(auditLog, { tool_name: 'gmail_create_filter', target_id: targetId, reason, status: 'success', duration_ms: Date.now() - started });
        return mcpText({ filter_id: targetId, status: 'created', audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, { tool_name: 'gmail_create_filter', target_id: 'pending', reason, status: 'error', duration_ms: Date.now() - started, error: extractGoogleError(error) });
        return mcpError('Unable to create Gmail filter', error);
      }
    },
  );

  server.registerTool(
    'gmail_delete_filter',
    {
      description: 'Deletes a Gmail filter by ID. Audited with reason.',
      inputSchema: z.object({
        filter_id: z.string().min(1),
        reason: z.string().min(3).max(500).default('filter no longer needed'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ filter_id, reason }) => {
      const started = Date.now();
      try {
        await gmail.users.settings.filters.delete({ userId: 'me', id: filter_id });
        const auditStatus = await tryAuditStateChange(auditLog, { tool_name: 'gmail_delete_filter', target_id: filter_id, reason, status: 'success', duration_ms: Date.now() - started });
        return mcpText({ filter_id, status: 'deleted', audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, { tool_name: 'gmail_delete_filter', target_id: filter_id, reason, status: 'error', duration_ms: Date.now() - started, error: extractGoogleError(error) });
        return mcpError(`Unable to delete filter ${filter_id}`, error);
      }
    },
  );

  server.registerTool(
    'gmail_audit_query',
    {
      description: 'Queries the local JSONL audit log (tool_name/status/search filters). Read-only; queries themselves are not audited to avoid recursion. Never contains bodies or secrets.',
      inputSchema: z.object({
        tool_name: z.string().min(1).optional(),
        status: z.enum(['success', 'error']).optional(),
        search: z.string().min(1).max(200).optional(),
        max_results: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ tool_name, status, search, max_results }) => {
      try {
        const result = await queryAuditLog(config.auditLogPath, {
          ...(tool_name ? { tool_name } : {}),
          ...(status ? { status } : {}),
          ...(search ? { search } : {}),
          max_results,
        });
        return mcpText(result);
      } catch (error) {
        return mcpError('Unable to query audit log', error);
      }
    },
  );

  server.registerTool(
    'gmail_watch_start',
    {
      description: 'Starts Gmail push notifications to a Cloud Pub/Sub topic (users.watch). Requires a topicName you own. Audited. Renew before expiration.',
      inputSchema: z.object({
        topic_name: z.string().min(1).describe('Full Pub/Sub topic, e.g. projects/PROJECT/topics/TOPIC'),
        label_ids: z.array(z.string().min(1)).max(20).optional().describe('Labels to watch (default INBOX)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ topic_name, label_ids }) => {
      const started = Date.now();
      const reason = 'start push watch';
      try {
        const response = await gmail.users.watch({
          userId: 'me',
          requestBody: { topicName: topic_name, ...(label_ids?.length ? { labelIds: label_ids } : {}) },
        });
        const auditStatus = await tryAuditStateChange(auditLog, { tool_name: 'gmail_watch_start', target_id: response.data.historyId ?? 'watch', reason, status: 'success', duration_ms: Date.now() - started });
        return mcpText({ history_id: response.data.historyId ?? '', expiration: response.data.expiration ?? '', audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, { tool_name: 'gmail_watch_start', target_id: 'watch', reason, status: 'error', duration_ms: Date.now() - started, error: extractGoogleError(error) });
        return mcpError('Unable to start Gmail watch', error);
      }
    },
  );

  server.registerTool(
    'gmail_watch_stop',
    {
      description: 'Stops Gmail push notifications (users.stop). Audited.',
      inputSchema: z.object({ reason: z.string().min(3).max(500).default('stop push watch') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ reason }) => {
      const started = Date.now();
      try {
        await gmail.users.stop({ userId: 'me' });
        const auditStatus = await tryAuditStateChange(auditLog, { tool_name: 'gmail_watch_stop', target_id: 'watch', reason, status: 'success', duration_ms: Date.now() - started });
        return mcpText({ status: 'stopped', audit_status: auditStatus });
      } catch (error) {
        await tryAuditStateChange(auditLog, { tool_name: 'gmail_watch_stop', target_id: 'watch', reason, status: 'error', duration_ms: Date.now() - started, error: extractGoogleError(error) });
        return mcpError('Unable to stop Gmail watch', error);
      }
    },
  );
}
