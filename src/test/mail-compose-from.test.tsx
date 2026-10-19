import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { Email, MailAccount } from '@/lib/mail-api';
import { useMailCompose } from '@/hooks/use-mail-compose';
import { MailComposeDialog, MailInlineCompose } from '@/components/mail/MailCompose';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const accounts = [
  { id: 'acc-a', email_address: 'alex@example.test', display_name: 'Alex', provider: 'custom', is_active: true, last_synced_at: null },
  { id: 'acc-b', email_address: 'alex.work@example.test', display_name: 'Alex (work)', provider: 'custom', is_active: true, last_synced_at: null },
] as MailAccount[];
const received: Email = {
  id: 'email-1', mail_account_id: 'acc-a', subject: 'Quote', from_address: 'sparks@example.test', from_name: 'Sparks', to_addresses: ['alex@example.test'],
  body_text: 'Here is the quote', body_html: null, folder: 'inbox', is_read: true, is_starred: false, received_at: '2026-10-10T08:00:00.000Z',
};

const draft: Email = {
  ...received, id: 'draft-1', folder: 'drafts', is_draft: true, subject: 'Plan', to_addresses: [],
  cc_addresses: ['copy@example.test', 'second@example.test'], bcc_addresses: ['hidden@example.test'], body_html: '<p>Draft</p>',
};

/** The Mail page in its combined view: no single account is open. */
function Host({ activeMailAccountId = null }: { activeMailAccountId?: string | null }) {
  const compose = useMailCompose({ activeMailAccountId, selectedAccount: activeMailAccountId ?? 'all', isMobile: false });
  return (
    <div>
      <button type="button" onClick={compose.openCompose}>New message</button>
      <button type="button" onClick={() => compose.startResponse(received, 'reply')}>Reply to Sparks</button>
      <button type="button" onClick={() => compose.openDraftForCompose(draft)}>Open draft</button>
      <MailComposeDialog compose={compose} accounts={accounts} isMobile={false} />
      {compose.isReplying && <MailInlineCompose compose={compose} />}
    </div>
  );
}
function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}
// The message editor is a contenteditable div, so it is found by id.
const fillAndSend = async (to: string, body: string, editorId: string) => {
  const toField = await screen.findByLabelText('To');
  fireEvent.change(toField, { target: { value: to } });
  const editor = document.getElementById(editorId)!;
  editor.innerHTML = `<p>${body}</p>`;
  fireEvent.input(editor);
  fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
};

beforeEach(() => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/mail/accounts')) return { data: { accounts } };
    if (path === '/settings/preferences') return { data: { preferences: { default_mail_account_id: 'acc-b' } } };
    return { data: { contacts: [{ id: 'c-1', first_name: 'Sparks', last_name: '', email: 'sparks@example.test' }] } };
  });
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'sent' } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('which account a message is sent from', () => {
  it('starts a new message from the account chosen in Settings when no single account is open', async () => {
    wrap(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'From' })).toHaveTextContent('alex.work@example.test'));
    await fillAndSend('someone@example.test', 'Hello', 'compose-body');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/send', expect.objectContaining({ account_id: 'acc-b', to: 'someone@example.test' }), expect.anything()));
  });

  it('starts from the open account, and replies from the account that received the message', async () => {
    wrap(<Host activeMailAccountId="acc-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'From' })).toHaveTextContent('alex@example.test'));
    cleanup();
    wrap(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Sparks' }));
    expect(await screen.findByLabelText('To')).toHaveValue('sparks@example.test');
    await fillAndSend('sparks@example.test', 'Thanks', 'compose-body-inline');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/send', expect.objectContaining({ account_id: 'acc-a' }), expect.anything()));
  });

  it('closes the contact list after a pick until more is typed, and sends a Bcc-only message', async () => {
    wrap(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    const toField = await screen.findByLabelText('To');
    fireEvent.focus(toField);
    fireEvent.change(toField, { target: { value: 'spa' } });
    fireEvent.mouseDown(await screen.findByRole('button', { name: /Sparks/ }));
    expect(toField).toHaveValue('Sparks <sparks@example.test>, ');
    expect(screen.queryByRole('button', { name: /Sparks/ })).toBeNull();
    fireEvent.change(toField, { target: { value: 'Sparks <sparks@example.test>, sp' } });
    expect(screen.getByRole('button', { name: /Sparks/ })).toBeInTheDocument();
    fireEvent.change(toField, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Bcc' }));
    fireEvent.change(screen.getByLabelText('Bcc'), { target: { value: 'hidden@example.test' } });
    const editor = document.getElementById('compose-body')!;
    editor.innerHTML = '<p>Quietly</p>';
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/send', expect.objectContaining({ to: '', cc: '', bcc: 'hidden@example.test' }), expect.anything()));
  });

  it('keeps a draft\'s Cc and Bcc when the draft is saved again', async () => {
    vi.mocked(api.put).mockResolvedValue({ data: { draft } });
    wrap(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Open draft' }));
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/drafts/draft-1', expect.objectContaining({
      account_id: 'acc-a', to: '', cc: 'copy@example.test, second@example.test', bcc: 'hidden@example.test',
    })));
  });
});

describe('sending a message once', () => {
  it('sends again with the same Idempotency-Key after a lost response, and a new message gets a new key', async () => {
    const sendKeys = () => vi.mocked(api.post).mock.calls.filter(([path]) => path === '/mail/send')
      .map(([, , options]) => (options as { headers: Record<string, string> }).headers['Idempotency-Key']);
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'Network error. Check your connection.' });
    wrap(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    await fillAndSend('someone@example.test', 'Hello', 'compose-body');
    await waitFor(() => expect(sendKeys()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(sendKeys()).toHaveLength(2));
    expect(sendKeys()[1]).toBe(sendKeys()[0]);

    // The second attempt succeeded and closed the message; the next one is a different message.
    await waitFor(() => expect(screen.queryByLabelText('To')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    await fillAndSend('other@example.test', 'Again', 'compose-body');
    await waitFor(() => expect(sendKeys()).toHaveLength(3));
    expect(sendKeys()[2]).not.toBe(sendKeys()[0]);
  });
});
