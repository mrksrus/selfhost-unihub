import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MailPage from '@/pages/MailPage';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getBlob: vi.fn(),
  },
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
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

const inboxEmail = {
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

const draftEmail = {
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

function setupApi(emails = [inboxEmail]) {
  vi.mocked(api.get).mockImplementation(async (endpoint: string) => {
    if (endpoint === '/mail/accounts') return { data: { accounts: [account] } };
    if (endpoint.startsWith('/contacts')) return { data: { contacts: [] } };
    if (endpoint === '/mail/folders') return { data: { folders } };
    if (endpoint.startsWith('/mail/unread-counts')) return { data: { unreadByFolder: { inbox: 1 }, unreadByFolderAccount: {} } };
    if (endpoint.startsWith('/mail/emails/draft-1')) return { data: { email: draftEmail } };
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

function renderMailPage(emails = [inboxEmail]) {
  setupApi(emails);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MailPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function getComposeEditor() {
  return screen.getAllByRole('textbox').find(element => element.getAttribute('aria-multiline') === 'true');
}

describe('MailPage UI regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows a save/discard prompt when closing a dirty compose', async () => {
    const { container } = renderMailPage();

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

  it('exposes both mark read and mark unread in the selection toolbar', async () => {
    renderMailPage([inboxEmail]);

    const row = await screen.findByText('Inbox subject');
    const listItem = row.closest('[class*="cursor-pointer"]') as HTMLElement;
    const checkboxButton = within(listItem).getAllByRole('button')[0];
    fireEvent.click(checkboxButton);

    expect(screen.getByRole('button', { name: /mark read/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark unread/i })).toBeInTheDocument();
  });

  it('opens draft rows in compose instead of the reader', async () => {
    renderMailPage([draftEmail]);

    fireEvent.click(await screen.findByText('Draft subject'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('Draft subject');
    expect(screen.getByText(/draft saved/i)).toBeInTheDocument();
  });

  it('keeps compose footer actions rendered with long content', async () => {
    const { container } = renderMailPage();

    fireEvent.click(await screen.findByRole('button', { name: /compose/i }));
    const editor = getComposeEditor();
    expect(editor).toBeTruthy();
    editor!.innerHTML = `<p>${'Long message '.repeat(1000)}</p>`;
    fireEvent.input(editor!);

    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save draft/i })).toBeInTheDocument();
  });
});
