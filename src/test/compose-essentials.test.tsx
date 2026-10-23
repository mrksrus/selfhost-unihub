import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { Email, MailAccount } from '@/lib/mail-api';
import { userSettingsQueryOptions, type UserSettingValues } from '@/lib/settings-api';
import { composeBody, responseRecipients } from '@/lib/compose-body';
import { useMailCompose } from '@/hooks/use-mail-compose';
import { useMailAccounts } from '@/hooks/use-mail-queries';
import { MailComposeDialog, MailComposeDialogs, MailInlineCompose } from '@/components/mail/MailCompose';
import { userSettingsAnswer } from './settings-fixtures';

const state = vi.hoisted(() => ({ toast: vi.fn(), settings: {} as Partial<UserSettingValues> }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const accounts = [
  { id: 'acc-a', email_address: 'alex@example.test', display_name: 'Alex', provider: 'custom', is_active: true, last_synced_at: null,
    signature_html: '<p>Alex <b>Example</b></p>', signature_text: 'Alex Example' },
  { id: 'acc-b', email_address: 'alex.work@example.test', display_name: 'Alex (work)', provider: 'custom', is_active: true, last_synced_at: null,
    signature_html: null, signature_text: 'Alex, Example Ltd' },
] as MailAccount[];
const received: Email = {
  id: 'email-1', mail_account_id: 'acc-a', subject: 'Quote', from_address: 'sparks@example.test', from_name: 'Sparks',
  to_addresses: ['alex@example.test', 'Bo <bo@example.test>'], cc_addresses: ['ALEX@example.test', 'cy@example.test', 'bo@example.test'],
  body_text: 'Here is the quote', body_html: null, folder: 'inbox', is_read: true, is_starred: false, received_at: '2026-10-10T08:00:00.000Z',
};

function Host() {
  const compose = useMailCompose({ activeMailAccountId: 'acc-a', selectedAccount: 'acc-a', isMobile: false });
  const loaded = useMailAccounts().data?.length ?? 0;
  const settingsLoaded = !!useQuery(userSettingsQueryOptions).data;
  return (
    <div>
      <p>{loaded} accounts{settingsLoaded ? ', settings' : ''}</p>
      <button type="button" onClick={compose.openCompose}>New message</button>
      <button type="button" onClick={() => compose.startResponse(received, 'replyAll')}>Reply all</button>
      <button type="button" onClick={() => compose.applyTemplate({ id: 't-1', name: 'Report', subject: 'Weekly report', body_html: '<p>Numbers attached.</p>', body_text: 'Numbers attached.', updated_at: '' })}>Use template</button>
      <MailComposeDialog compose={compose} accounts={accounts} isMobile={false} />
      <MailComposeDialogs compose={compose} />
      {compose.isReplying && <MailInlineCompose compose={compose} />}
    </div>
  );
}
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><Host /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  // Radix Select scrolls the chosen option into view; jsdom has no layout.
  Element.prototype.scrollIntoView ??= () => {};
  state.settings = {};
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/mail/accounts')) return { data: { accounts } };
    if (path === '/settings/values') return userSettingsAnswer(state.settings);
    return { data: { contacts: [] } };
  });
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'sent' } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('reply all', () => {
  it('writes to the sender and everyone on To and Cc, without your own address or anyone twice', () => {
    expect(responseRecipients(received, 'replyAll', 'alex@example.test')).toEqual({ to: 'sparks@example.test, Bo <bo@example.test>', cc: 'cy@example.test' });
    expect(responseRecipients(received, 'reply', 'alex@example.test')).toEqual({ to: 'sparks@example.test', cc: '' });
  });

  it('a new message without a signature starts empty, so the editor shows its placeholder', () => {
    expect(composeBody('rich', '')).toBe('');
    expect(composeBody('plain', '')).toBe('');
    expect(composeBody('rich', '<p>Sig</p>')).toBe('<p><br></p><p>Sig</p>');
  });

  it('opens a reply to all from the account that received the message', async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'Reply all' }));
    expect(await screen.findByLabelText('To')).toHaveValue('sparks@example.test, Bo <bo@example.test>');
    expect(screen.getByLabelText('Cc')).toHaveValue('cy@example.test');
  });
});

describe('signatures', () => {
  it('a new message carries the account signature, and follows the From account until something is written', async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    const editor = () => document.getElementById('compose-body')!;
    await waitFor(() => expect(editor().innerHTML).toContain('Alex <b>Example</b>'));
    fireEvent.click(screen.getByRole('combobox', { name: 'From' }));
    fireEvent.click(await screen.findByRole('option', { name: /alex\.work@example\.test/ }));
    await waitFor(() => expect(editor().innerHTML).toContain('Alex, Example Ltd'));
    expect(editor().innerHTML).not.toContain('Alex <b>Example</b>');
  });

  it('a reply puts the signature above the quoted message', async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'Reply all' }));
    await waitFor(() => expect(document.getElementById('compose-body-inline')!.innerHTML).toMatch(/Alex <b>Example<\/b>[\s\S]*<blockquote>/));
  });
});

describe('compose format', () => {
  it('in plain text the message is written and sent as plain text, with the plain signature', async () => {
    state.settings = { compose_format: 'plain' };
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    const body = await screen.findByPlaceholderText('Write your message...');
    await waitFor(() => expect(body).toHaveValue('\n\n-- \nAlex Example'));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'sparks@example.test' } });
    fireEvent.change(body, { target: { value: 'Plain hello\n\n-- \nAlex Example' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/send', expect.objectContaining({ isHtml: false, body: 'Plain hello\n\n-- \nAlex Example' }), expect.anything()));
  });
});

describe('templates', () => {
  it('a template fills an empty subject and starts the text above the signature', async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    await waitFor(() => expect(document.getElementById('compose-body')!.innerHTML).toContain('Alex <b>Example</b>'));
    fireEvent.click(screen.getByRole('button', { name: 'Use template', hidden: true }));
    expect(await screen.findByDisplayValue('Weekly report')).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById('compose-body')!.innerHTML).toMatch(/^<p>Numbers attached\.<\/p>[\s\S]*Alex <b>Example<\/b>/));
  });
});
