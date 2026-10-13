import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { MailAccount, MailFolder } from '@/lib/mail-api';
import { MailFolderDialogs } from '@/components/mail/MailFolderDialogs';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

const account = { id: 'acc-1', email_address: 'alex@example.test', is_active: true } as MailAccount;
const folders: MailFolder[] = [
  { id: 'f-notes', slug: 'notes', display_name: 'Notes', is_system: false, position: 100, total_count: 3, mail_account_id: null },
  { id: 'f-projects', slug: 'projects', display_name: 'Projects', is_system: false, position: 110, total_count: 2, mail_account_id: 'acc-1' },
  { id: 'f-inbox', slug: 'inbox', display_name: 'Inbox', is_system: true, position: 0, total_count: 10 },
];

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <MailFolderDialogs open onOpenChange={() => {}} activeMailAccountId="acc-1" folders={folders} accounts={[account]} selectedFolder="inbox" onSelectFolder={() => {}} />
  </QueryClientProvider>);
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('deleting a mail folder', () => {
  it('a local folder is deleted at once; a system folder cannot be', async () => {
    vi.mocked(api.delete).mockResolvedValue({ data: { deletedMessages: 0, movedMessages: 3 } });
    show();
    expect(screen.getByRole('button', { name: 'Delete Inbox' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Notes' }));
    expect(await screen.findByText('Delete Notes?')).toBeInTheDocument();
    expect(screen.getByText('3 messages and the rules filing into it move back to Inbox.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/mail/folders/notes'));
  });

  it('a server folder needs the explicit choice and is then deleted on the server too', async () => {
    vi.mocked(api.delete).mockResolvedValue({ data: { deletedMessages: 2, movedMessages: 0 } });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Projects' }));
    expect(await screen.findByText('Delete Projects?')).toBeInTheDocument();
    expect(screen.getByText(/on the mail server \(alex@example.test\)/)).toBeInTheDocument();
    const action = screen.getByRole('button', { name: 'Delete on server and in UniHub' });
    expect(action).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(action).toBeEnabled();
    fireEvent.click(action);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/mail/folders/projects?server=1'));
  });
});
