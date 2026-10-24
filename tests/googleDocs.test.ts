import { describe, expect, it, vi } from 'vitest';
import { fetchDocText, parseDriveDocId } from '../src/utils/googleDocs.js';
import type { DriveClient } from '../src/types/index.js';

describe('parseDriveDocId', () => {
  it('accepts a bare document ID', () => {
    expect(parseDriveDocId('1_E8rjbfs3iECfg4NEoNiw3lY9q2d0EbJ0ZR9FNy0mVw')).toBe(
      '1_E8rjbfs3iECfg4NEoNiw3lY9q2d0EbJ0ZR9FNy0mVw',
    );
  });

  it('extracts the ID from a full Docs URL with tab params', () => {
    expect(
      parseDriveDocId('https://docs.google.com/document/d/1_E8rjbfs3iECfg4NEoNiw3lY9q2d0EbJ0ZR9FNy0mVw/edit?usp=meet_tnfm_email&tab=t.drf7ej19ketg'),
    ).toBe('1_E8rjbfs3iECfg4NEoNiw3lY9q2d0EbJ0ZR9FNy0mVw');
  });

  it('rejects empty and non-Docs input', () => {
    expect(() => parseDriveDocId('')).toThrow(/empty/);
    expect(() => parseDriveDocId('https://example.com/not-a-doc')).toThrow(/Invalid Google Docs/);
    expect(() => parseDriveDocId('hola mundo con espacios')).toThrow(/Invalid Google Docs/);
  });
});

describe('fetchDocText', () => {
  function driveWith(text: unknown): DriveClient {
    return {
      files: { export: vi.fn(async () => ({ data: text })) },
    } as unknown as DriveClient;
  }

  it('returns plain text within the cap', async () => {
    const result = await fetchDocText(driveWith('Hola\nmundo'), 'doc1234567890', 200000);
    expect(result).toEqual({ text: 'Hola\nmundo', truncated: false });
  });

  it('truncates overlong exports with a marker', async () => {
    const result = await fetchDocText(driveWith('x'.repeat(100)), 'doc1234567890', 30);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('[CONTENIDO TRUNCADO');
  });

  it('propagates API errors to the caller', async () => {
    const drive = {
      files: { export: vi.fn(async () => { throw new Error('Request failed with status code 404'); }) },
    } as unknown as DriveClient;
    await expect(fetchDocText(drive, 'doc1234567890', 200000)).rejects.toThrow(/404/);
  });
});
