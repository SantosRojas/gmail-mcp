import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const srcRoot = resolve(process.cwd(), 'src');

async function readSource(path: string): Promise<string> {
  return readFile(join(srcRoot, path), 'utf8');
}

describe('permanent deletion guardrail', () => {
  it('does not reference forbidden Gmail permanent-delete methods', async () => {
    const files = ['index.ts', 'tools/readTools.ts', 'tools/writeTools.ts', 'tools/manageTools.ts', 'tools/draftTools.ts', 'tools/messageTools.ts', 'tools/organizeTools.ts', 'tools/driveSendTools.ts', 'tools/contactsTools.ts', 'auth/googleAuth.ts'];
    const sources = await Promise.all(files.map(readSource));
    const joined = sources.join('\n');
    expect(joined).not.toMatch(/users\.(messages|threads)\.delete/);
    expect(joined).not.toMatch(/messages\.delete\s*\(/);
    expect(joined).not.toMatch(/threads\.delete\s*\(/);
  });

  it('contains the required soft-delete and recovery API calls', async () => {
    const manage = await readSource('tools/manageTools.ts');
    expect(manage).toContain('gmail.users.messages.trash');
    expect(manage).toContain('gmail.users.threads.trash');
    expect(manage).toContain('gmail.users.messages.untrash');
    expect(manage).toContain('gmail.users.threads.untrash');
  });

  it('contacts module stays read-only (no create/update/delete)', async () => {
    const contacts = await readSource('tools/contactsTools.ts');
    expect(contacts).toContain('contacts_search');
    expect(contacts).toContain('contacts_get');
    expect(contacts).not.toMatch(/createContact|updateContact|deleteContact/i);
  });
});
