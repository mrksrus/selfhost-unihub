import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { MailAccount, MailFolder } from '@/lib/mail-api';
import { MailFolderDialogs } from '@/components/mail/MailFolderDialogs';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));

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
  return client;
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

  // Deleted on one account's server, not yet on another's (409 FOLDER_PARTLY_DELETED): what went where, and the folders read again.
  it('a folder deleted on some servers only says where it went and where it stays, and reads the folders again', async () => {
    vi.mocked(api.delete).mockResolvedValue({ status: 409, error: 'The folder was deleted on some servers only.', code: 'FOLDER_PARTLY_DELETED',
      details: { deleted_on: ['a@example.org'], remaining_on: ['b@example.org'], settled: true } });
    const client = show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Projects' }));
    await screen.findByText('Delete Projects?');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete on server and in UniHub' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Folder partly deleted', description: 'Deleted on a@example.org. Still on b@example.org: try again later.' })));
    expect(invalidate).toHaveBeenCalled();
  });

  it('an earlier attempt without an answer, with the folder still on the server, says so and keeps the folder deletable', async () => {
    vi.mocked(api.delete).mockResolvedValue({ status: 409, error: 'UniHub could not tell whether an earlier attempt deleted the folder on the mail server (alex@example.test), and the server lists it. Try again after the next mail sync.', code: 'FOLDER_DELETE_UNCERTAIN' });
    const client = show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Projects' }));
    await screen.findByText('Delete Projects?');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete on server and in UniHub' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Folder not deleted', description: "UniHub couldn't confirm the deletion on alex@example.test; the folder is still there. Try again." })));
    expect(invalidate).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete Projects' })).toBeEnabled();
  });

  it('a mail server that refused shows the safe sentence and reads the folders again', async () => {
    vi.mocked(api.delete).mockResolvedValue({ status: 502, error: 'Could not connect to the mail server (alex@example.test). Nothing was changed.', code: 'MAIL_SERVER_ERROR' });
    const client = show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Projects' }));
    await screen.findByText('Delete Projects?');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete on server and in UniHub' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Folder not deleted', description: 'Could not connect to the mail server (alex@example.test). Nothing was changed.' })));
    expect(invalidate).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete Projects' })).toBeEnabled();
  });

  it('a folder gone from every server whose UniHub copy could not be updated asks to delete it again', async () => {
    vi.mocked(api.delete).mockResolvedValue({ status: 409, error: 'The folder was deleted on the mail server, but UniHub could not update its copy yet.', code: 'FOLDER_PARTLY_DELETED',
      details: { deleted_on: ['alex@example.test'], remaining_on: [], settled: false } });
    const client = show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Projects' }));
    await screen.findByText('Delete Projects?');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete on server and in UniHub' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Folder partly deleted', description: 'Deleted on alex@example.test. Delete it again to finish; nothing is sent to the server again.' })));
    expect(invalidate).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete Projects' })).toBeEnabled();
  });
});
