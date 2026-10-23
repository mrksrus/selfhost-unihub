import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { mailQueryKeys, showRequestedReadInMailLists, showRequestedSnoozeInMailCaches, type Email, type MailListResponse, type MailListRow, type MailThreadListResponse, type MailThreadSummary } from '@/lib/mail-api';

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

describe('pending snooze', () => {
  it('an undone snooze puts back only its own message, at its place, and keeps a second snooze made meanwhile', () => {
    const client = new QueryClient();
    const [a, b, c] = ['a', 'b', 'c'].map(id => ({ id, is_read: true }) as Email);
    const inboxKey = mailQueryKeys.list({ account: 'all', folder: 'inbox', page: 1, search: '', unreadOnly: false });
    client.setQueryData<MailListResponse>(inboxKey, { emails: [a, b, c], pagination: { page: 1, limit: 50, offset: 0, total: 3, totalPages: 1 } });
    const ids = () => client.getQueryData<MailListResponse>(inboxKey)?.emails.map(email => email.id);

    const undoA = showRequestedSnoozeInMailCaches(client, new Set(['a']), true);
    showRequestedSnoozeInMailCaches(client, new Set(['b']), true);
    expect(ids()).toEqual(['c']);

    undoA();
    expect(ids()).toEqual(['a', 'c']);
    expect(client.getQueryData<MailListResponse>(inboxKey)?.pagination?.total).toBe(2);
    undoA();
    expect(ids()).toEqual(['a', 'c']);
  });

  it('an undone snooze does not add a conversation that a refetch already shows with a newer message', () => {
    const client = new QueryClient();
    const thread = (key: string, latest: string) => ({ thread_key: key, latest: { id: latest } as MailListRow, message_count: 1, unread_count: 0, total_count: 1,
      has_attachments: false, is_starred: false, participants: [] }) as MailThreadSummary;
    const key = mailQueryKeys.threads({ account: 'all', folder: 'inbox', page: 1, search: '', unreadOnly: false }, null);
    const pagination = { total: null, limit: 50, offset: 0, page: 1, totalPages: null, hasMore: false, next_cursor: null };
    client.setQueryData<MailThreadListResponse>(key, { threads: [thread('k1', 'a'), thread('k2', 'b')], pagination });
    const undo = showRequestedSnoozeInMailCaches(client, new Set(['a']), true);
    client.setQueryData<MailThreadListResponse>(key, { threads: [thread('k1', 'a2'), thread('k2', 'b')], pagination });
    undo();
    expect(client.getQueryData<MailThreadListResponse>(key)?.threads.map(item => item.latest.id)).toEqual(['a2', 'b']);
  });
});
