import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { mailQueryKeys, showRequestedReadInMailLists, type Email, type MailListResponse } from '@/lib/mail-api';

describe('pending mail read state', () => {
  it('shows a requested change in every cached mail list before the provider responds', () => {
    const client = new QueryClient();
    const one = { id: 'one', is_read: false } as Email;
    const two = { id: 'two', is_read: false } as Email;
    const inboxKey = mailQueryKeys.list({ account: 'all', folder: 'inbox', page: 1, search: '', unreadOnly: false });
    const searchKey = mailQueryKeys.list({ account: 'all', folder: 'all', page: 1, search: 'one', unreadOnly: false });
    client.setQueryData<MailListResponse>(inboxKey, { emails: [one, two] });
    client.setQueryData<MailListResponse>(searchKey, { emails: [one] });

    showRequestedReadInMailLists(client, ['one'], true);

    expect(client.getQueryData<MailListResponse>(inboxKey)?.emails.map(email => email.is_read)).toEqual([true, false]);
    expect(client.getQueryData<MailListResponse>(searchKey)?.emails[0].is_read).toBe(true);
  });
});
