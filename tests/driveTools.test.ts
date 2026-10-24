import { describe, expect, it, vi } from 'vitest';
import { registerDriveTools } from '../src/tools/driveTools.js';
import type { AppConfig } from '../src/config.js';
import type { DriveClient } from '../src/types/index.js';
import type { McpServer } from '@modelcontextprotocol/server';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function handlersFor(drive: DriveClient): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerDriveTools(server as unknown as McpServer, drive, { maxBodyLength: 200000 } as AppConfig);
  return handlers;
}

function parseText(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

describe('drive_get_doc_text', () => {
  it('exports doc text for a valid URL', async () => {
    const drive = {
      files: { export: vi.fn(async () => ({ data: 'Checklist de despliegue\n1. Docker' })) },
    } as unknown as DriveClient;
    const result = await handlersFor(drive).get('drive_get_doc_text')?.({
      doc_url_or_id: 'https://docs.google.com/document/d/1_E8rjbfs3iECfg4NEoNiw3lY9q2d0EbJ0ZR9FNy0mVw/edit',
    });
    const body = parseText(result as { content: Array<{ text: string }> });
    expect(body.document_id).toBe('1_E8rjbfs3iECfg4NEoNiw3lY9q2d0EbJ0ZR9FNy0mVw');
    expect(body.text).toContain('Checklist');
    expect(body.truncated).toBe(false);
  });

  it('rejects invalid input without calling the API', async () => {
    const exportSpy = vi.fn(async () => ({ data: 'x' }));
    const drive = { files: { export: exportSpy } } as unknown as DriveClient;
    const result = await handlersFor(drive).get('drive_get_doc_text')?.({ doc_url_or_id: 'not a doc' });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it('surfaces API errors as tool errors', async () => {
    const drive = {
      files: { export: vi.fn(async () => { throw new Error('Request failed with status code 404'); }) },
    } as unknown as DriveClient;
    const result = await handlersFor(drive).get('drive_get_doc_text')?.({ doc_url_or_id: '1_E8rjbfs3iECfg4NEoNiw3lY9q2d0EbJ0ZR9FNy0mVw' });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
