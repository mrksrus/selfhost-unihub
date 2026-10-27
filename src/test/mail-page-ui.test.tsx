import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MailPage from '@/pages/MailPage';
import { api } from '@/lib/api';
import { mailQueryKeys, type Email } from '@/lib/mail-api';
import { closeMailPeek, openMailPeek } from '@/lib/mail-peek';
import { setOfflineMode } from '@/lib/offline';
import { AuthContext, type AuthContextType } from '@/contexts/auth-context';
import { MailPeek } from '@/components/mail/MailPeek';
import { applyMailPageWaitBudget, MAIL_PAGE_TEST_TIMEOUT } from '@/test/helpers/mail-page-budget';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getBlob: vi.fn(),
  },
}));

const account = {
  id: 'account-1',
  email_address: 'sender@example.test',
  display_name: 'Sender',
  provider: 'custom',
  is_active: true,
  last_synced_at: null,
};

const folders = [
  { id: 'f-inbox', slug: 'inbox', display_name: 'Inbox', is_system: true, position: 10, total_count: 1, unread_count: 1 },
  { id: 'f-sent', slug: 'sent', display_name: 'Sent', is_system: true, position: 20, total_count: 0, unread_count: 0 },
  { id: 'f-drafts', slug: 'drafts', display_name: 'Drafts', is_system: true, position: 30, total_count: 1, unread_count: 0 },
  { id: 'f-trash', slug: 'trash', display_name: 'Trash', is_system: true, position: 40, total_count: 0, unread_count: 0 },
];

const inboxEmail: Email = {
  id: 'email-1',
  mail_account_id: 'account-1',
  subject: 'Inbox subject',
  from_address: 'reader@example.test',
  from_name: 'Reader',
  to_addresses: ['sender@example.test'],
  body_text: 'Inbox body',
  body_html: null,
  folder: 'inbox',
  is_read: false,
  is_starred: false,
  is_draft: false,
  received_at: '2026-06-16T10:00:00.000Z',
  has_attachments: false,
};

const draftEmail: Email = {
  id: 'draft-1',
  mail_account_id: 'account-1',
  subject: 'Draft subject',
  from_address: 'sender@example.test',
  from_name: 'Sender',
  to_addresses: ['reader@example.test'],
  body_text: 'Draft body',
  body_html: '<p>Draft body</p>',
  folder: 'drafts',
  is_read: true,
  is_starred: false,
  is_draft: true,
  received_at: '2026-06-16T11:00:00.000Z',
  has_attachments: false,
  attachments: [],
};

// A draft written in another client that quoted a hostile message; the provider's Drafts folder brings it here.
const hostileDraft: Email = {
  ...draftEmail,
  id: 'draft-2',
  subject: 'Quoted draft subject',
  body_text: 'Quoted offer',
  body_html: '<p>Quoted <b>offer</b></p><img src="x" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">terms</a>',
};

const peekEmail: Email = { ...inboxEmail, id: 'email-2', subject: 'Peek subject', body_text: 'Peek body', is_read: true };

function setupApi(emails = [inboxEmail], accountPatch: Record<string, unknown> = {}) {
  vi.mocked(api.get).mockImplementation(async (endpoint: string) => {
    if (endpoint === '/mail/accounts') return { data: { accounts: [{ ...account, ...accountPatch }] } };
    if (endpoint.startsWith('/contacts')) return { data: { contacts: [] } };
    if (endpoint === '/mail/folders') return { data: { folders } };
    if (endpoint.startsWith('/mail/unread-counts')) return { data: { unreadByFolder: { inbox: 1 }, unreadByFolderAccount: {} } };
    if (endpoint.startsWith('/mail/emails/draft-1')) return { data: { email: draftEmail } };
    if (endpoint.startsWith('/mail/emails/draft-2')) return { data: { email: hostileDraft } };
    if (endpoint.startsWith('/mail/emails/email-2')) return { data: { email: peekEmail } };
    if (endpoint.startsWith('/mail/emails/email-1')) return { data: { email: inboxEmail } };
    if (endpoint.startsWith('/mail/emails?')) {
      return {
        data: {
          emails,
          pagination: { total: emails.length, limit: 50, offset: 0, page: 1, totalPages: 1 },
        },
      };
    }
    return { data: {} };
  });
  vi.mocked(api.post).mockResolvedValue({ data: { draft: { ...draftEmail, id: 'draft-auto', subject: 'Long draft' } } });
  vi.mocked(api.put).mockResolvedValue({ data: {} });
  vi.mocked(api.delete).mockResolvedValue({ data: { deleted: true } });
}

function renderMailPage(emails: Email[] = [inboxEmail], initialEntry = '/mail', accountPatch: Record<string, unknown> = {}) {
  setupApi(emails, accountPatch);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <MailPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** The Mail page with the app layout's email peek beside it, sharing one query cache. */
function renderMailPageWithPeek(emails: Email[]) {
  setupApi(emails);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const auth = { user: { id: 'owner', email: 'owner@example.test' }, session: { authenticated: true } } as unknown as AuthContextType;
  render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/mail']}><MailPage /><MailPeek /></MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  return queryClient;
}

function getComposeEditor() {
  return screen.getAllByRole('textbox').find(element => element.getAttribute('aria-multiline') === 'true');
}

applyMailPageWaitBudget();

describe('MailPage UI regressions', { timeout: MAIL_PAGE_TEST_TIMEOUT }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setOfflineMode(false);
  });
  afterEach(() => { cleanup(); closeMailPeek(); });

  it('opens notification mail outside the visible list without marking saved offline mail read', async () => {
    setOfflineMode(true);
    renderMailPage([], '/mail?email=email-1');
    expect(await screen.findByText('Inbox body')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/mail/emails/email-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(api.put).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  // B-25: "Open in Mail" from a task's email. React Router applies the URL
  // change as a transition, so the page renders again with the link still in it
  // before the parameter is gone; the link must open the message only once.
  it('opens a linked unread message once, marks it read and finishes loading', async () => {
    renderMailPage([inboxEmail], '/mail?email=email-1');
    expect(await screen.findByText('Inbox body')).toBeInTheDocument();
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/email-1/read', { is_read: true }, expect.any(Object)));
    await new Promise(resolve => setTimeout(resolve, 50));
    const opened = vi.mocked(api.get).mock.calls.filter(([endpoint]) => endpoint === '/mail/emails/email-1');
    expect(opened).toHaveLength(1);
    expect(api.put).not.toHaveBeenCalledWith('/mail/emails/email-1/read', { is_read: false }, expect.anything());
    expect(screen.queryByText('Loading email…')).not.toBeInTheDocument();
  });

  it('opens the sync panel when arriving from the attention tray', async () => {
    renderMailPage([inboxEmail], '/mail?review=sync');
    expect(await screen.findByRole('dialog', { name: 'Mail sync' })).toBeInTheDocument();
  });

  it('shows a save/discard prompt when closing a dirty compose', async () => {
    renderMailPage();

    fireEvent.click(await screen.findByRole('button', { name: /compose/i }));
    fireEvent.change(await screen.findByLabelText('Subject'), { target: { value: 'Long draft' } });
    const editor = getComposeEditor();
    expect(editor).toBeTruthy();
    editor!.innerHTML = '<p>Long message body</p>';
    fireEvent.input(editor!);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(await screen.findByText('Save this draft?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep editing/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save draft/i })).toBeInTheDocument();
  });

  it('keeps Starred available as a virtual flag view when no Starred mailbox exists', async () => {
    renderMailPage([inboxEmail]);

    fireEvent.click(await screen.findByRole('button', { name: /starred/i }));

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(expect.stringContaining('folder=starred'), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
  });

  it('opens draft rows in compose instead of the reader', async () => {
    renderMailPage([draftEmail]);

    fireEvent.click(await screen.findByText('Draft subject'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('Draft subject');
    expect(screen.getByText(/draft saved/i)).toBeInTheDocument();
  });

  it('opens a stored draft with inert content in the editor', async () => {
    renderMailPage([hostileDraft]);

    fireEvent.click(await screen.findByText('Quoted draft subject'));
    await screen.findByRole('dialog');
    const editor = getComposeEditor();
    expect(editor).toBeDefined();
    await waitFor(() => expect(editor).toHaveTextContent('Quoted offer'));
    expect(editor!.querySelector('b')).toHaveTextContent('offer');
    expect(editor!.querySelector('[onerror], script, a[href^="javascript:"]')).toBeNull();
    expect(editor!.innerHTML).not.toMatch(/onerror|<script|javascript:/i);
  });

  it('marks a message read and loads it while an email peek is cached', async () => {
    const queryClient = renderMailPageWithPeek([inboxEmail, peekEmail]);
    await screen.findByText('Inbox subject');
    act(() => openMailPeek('email-2'));
    const peek = await screen.findByRole('dialog', { name: 'Email' });
    await within(peek).findByText('Peek body');
    act(() => closeMailPeek());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Email' })).not.toBeInTheDocument());
    expect(queryClient.getQueryData(mailQueryKeys.detail('email-2'))).toMatchObject({ id: 'email-2' });

    fireEvent.click(screen.getByText('Inbox subject'));
    expect(await screen.findByText('Inbox body')).toBeInTheDocument();
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/emails/email-1/read', { is_read: true }, expect.any(Object)));
    // The peek's cached message is left alone by the list patch.
    expect(queryClient.getQueryData(mailQueryKeys.detail('email-2'))).toMatchObject({ id: 'email-2', is_read: true });
  });
});
