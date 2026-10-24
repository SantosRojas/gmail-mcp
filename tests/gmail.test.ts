import { describe, expect, it } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { paginateMessages, renderThreadMarkdown, fetchThreadHeaders, fetchLabelCounts } from '../src/utils/gmail.js';
import type { GmailClient } from '../src/types/index.js';

function message(id: string, bodyText: string): gmail_v1.Schema$Message {
  return {
    id,
    threadId: 't1',
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'a@example.com' },
        { name: 'Subject', value: 'Hola' },
      ],
      body: { data: Buffer.from(bodyText, 'utf8').toString('base64') },
    },
  };
}

describe('paginateMessages', () => {
  it('slices 1-based pages and reports both omission sides', () => {
    const page = paginateMessages([1, 2, 3, 4, 5], 2, 2);
    expect(page.page).toEqual([2, 3]);
    expect(page.omittedBefore).toBe(1);
    expect(page.omittedAfter).toBe(2);
  });

  it('clamps out-of-range starts to an empty page', () => {
    const page = paginateMessages([1, 2], 10, 5);
    expect(page.page).toEqual([]);
    expect(page.omittedBefore).toBe(2);
    expect(page.omittedAfter).toBe(0);
  });
});

describe('renderThreadMarkdown counts', () => {
  it('reports full inclusion when everything fits', () => {
    const result = renderThreadMarkdown([message('m1', 'uno'), message('m2', 'dos')], false, 20000, 60000);
    expect(result.includedCount).toBe(2);
    expect(result.omittedCount).toBe(0);
    expect(result.markdown).toContain('Mensaje 1');
  });

  it('counts messages dropped by the thread char cap', () => {
    const msgs = [message('m1', 'x'.repeat(20)), message('m2', 'y'.repeat(20)), message('m3', 'z'.repeat(20))];
    const result = renderThreadMarkdown(msgs, false, 20000, 30);
    expect(result.includedCount).toBe(2);
    expect(result.includedCount + result.omittedCount).toBe(3);
  });

  it('handles empty threads', () => {
    const result = renderThreadMarkdown([], false, 20000, 60000);
    expect(result).toMatchObject({ includedCount: 0, omittedCount: 0, markdown: '' });
  });

  it('numbers headings from the page start', () => {
    const result = renderThreadMarkdown([message('m1', 'uno')], false, 20000, 60000, 2);
    expect(result.markdown).toContain('### Mensaje 2');
  });
});

describe('fetchThreadHeaders', () => {
  function gmailWithHeaders(headers: Array<{ name?: string | null; value?: string | null }> | null): GmailClient {
    return {
      users: {
        threads: {
          get: async () => {
            if (headers === null) throw new Error('gone');
            return { data: { messages: [{ payload: { headers } }] } };
          },
        },
      },
    } as unknown as GmailClient;
  }

  it('extracts From and Date from the first message', async () => {
    const result = await fetchThreadHeaders(
      gmailWithHeaders([
        { name: 'From', value: 'César Chalén <cchalen@example.com>' },
        { name: 'Date', value: 'Tue, 06 Oct 2026 16:00:50 +0000' },
      ]),
      't1',
    );
    expect(result).toEqual({ from: 'César Chalén <cchalen@example.com>', date: 'Tue, 06 Oct 2026 16:00:50 +0000' });
  });

  it('degrades to empty strings instead of failing the whole listing', async () => {
    const result = await fetchThreadHeaders(gmailWithHeaders(null), 't1');
    expect(result).toEqual({ from: '', date: '' });
  });
});

describe('fetchLabelCounts', () => {
  it('estimates totals via filtered searches', async () => {
    const gmail = {
      users: { threads: { list: async () => ({ data: { resultSizeEstimate: 42 } }) } },
    } as unknown as GmailClient;
    const result = await fetchLabelCounts(gmail, 'INBOX');
    expect(result).toEqual({ total: 42, unread: 42 });
  });
});
