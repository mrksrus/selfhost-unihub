import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { MailAccount, MailFolder } from '@/lib/mail-api';
import { MailFolderDialogs } from '@/components/mail/MailFolderDialogs';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));

const account = { id: 'acc-1', email_address: 'alex@example.test', is_active: true } as MailAccount;
const second = { id: 'acc-2', email_address: 'alex@example.org', is_active: true } as MailAccount;
// The copies as the folder listing gives them: the generation deleting names.
const projectsCopy = { account_id: 'acc-1', remote_name: 'Projects', uidvalidity: '17', mailbox_id: null };
const sharedCopies = [{ account_id: 'acc-1', remote_name: 'Shared', uidvalidity: '4', mailbox_id: 'F-shared-1' },
  { account_id: 'acc-2', remote_name: 'Shared', uidvalidity: '9', mailbox_id: null }];
const folders: MailFolder[] = [
  { id: 'f-notes', slug: 'notes', display_name: 'Notes', is_system: false, position: 100, total_count: 3, mail_account_id: null, server_copies: [] },
  { id: 'f-projects', slug: 'projects', display_name: 'Projects', is_system: false, position: 110, total_count: 2, mail_account_id: 'acc-1', server_copies: [projectsCopy] },
  { id: 'f-shared', slug: 'shared', display_name: 'Shared', is_system: false, position: 120, total_count: 5, mail_account_id: null, connected_account_ids: ['acc-1', 'acc-2'], server_copies: sharedCopies },
  { id: 'f-inbox', slug: 'inbox', display_name: 'Inbox', is_system: true, position: 0, total_count: 10 },
];

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <MailFolderDialogs open onOpenChange={() => {}} activeMailAccountId="acc-1" folders={folders} accounts={[account, second]} selectedFolder="inbox" onSelectFolder={() => {}} />
  </QueryClientProvider>);
  return client;
}
async function deleteOnServer(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `Delete ${name}` }));
  await screen.findByText(`Delete ${name}?`);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete on server and in UniHub' }));
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
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/mail/folders/notes', undefined));
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
    // The copy shown, with its generation: the server deletes that one only.
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/mail/folders/projects?server=1', { copies: [projectsCopy] }));
  });

  it('a folder on two servers names both copies with their generations', async () => {
    vi.mocked(api.delete).mockResolvedValue({ data: { deletedMessages: 5, movedMessages: 0 } });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Shared' }));
    expect(await screen.findByText(/on the mail server \(alex@example.test, alex@example.org\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete on server and in UniHub' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/mail/folders/shared?server=1', { copies: sharedCopies }));
  });

  // Deleted on one account's server, not on another's (409 FOLDER_PARTLY_DELETED): the result of each
  // server stays on screen, with what the others need, and the folders are read again.
  it('a folder deleted on some servers only shows each server\'s result and reads the folders again', async () => {
    vi.mocked(api.delete).mockResolvedValue({ status: 409, error: 'The folder changed on the mail server (alex@example.org) since it was shown.', code: 'FOLDER_PARTLY_DELETED',
      details: { deleted_on: ['alex@example.test'], remaining_on: ['alex@example.org'], settled: true, copies: [
        { account_id: 'acc-1', email_address: 'alex@example.test', outcome: 'deleted' },
        { account_id: 'acc-2', email_address: 'alex@example.org', outcome: 'changed' }] } });
    const client = show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await deleteOnServer('Shared');
    const result = await screen.findByRole('alertdialog', { name: 'Shared was deleted on some servers only' });
    expect(within(result).getByText('It stays in UniHub for the servers that still have it.')).toBeInTheDocument();
    const rows = within(within(result).getByRole('list', { name: 'Result on each mail server' })).getAllByRole('listitem');
    expect(rows.map(row => row.textContent)).toEqual([
      'alex@example.testDeleted',
      'alex@example.orgNot deleted: the folder changed on this server since it was shown. Check it, then delete it again.',
    ]);
    expect(state.toast).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
    fireEvent.click(within(result).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('a server that failed after another deleted its copy says to try again later', async () => {
    vi.mocked(api.delete).mockResolvedValue({ status: 409, error: 'Could not delete the folder on the mail server (alex@example.org).', code: 'FOLDER_PARTLY_DELETED',
      details: { deleted_on: ['alex@example.test'], remaining_on: ['alex@example.org'], settled: true, copies: [
        { account_id: 'acc-1', email_address: 'alex@example.test', outcome: 'deleted' },
        { account_id: 'acc-2', email_address: 'alex@example.org', outcome: 'failed' }] } });
    show();
    await deleteOnServer('Shared');
    const result = await screen.findByRole('alertdialog', { name: 'Shared was deleted on some servers only' });
    expect(within(result).getByText('Not deleted: the server did not delete it. Try again later.')).toBeInTheDocument();
  });

  // The final check refused (a rule, Mail off, a restore, the account changed): nothing was deleted; the server's sentence, and the folders read again.
  it('a refusal at the final check shows the server\'s sentence and reads the folders again', async () => {
    vi.mocked(api.delete).mockResolvedValue({ status: 403, error: 'Your administrator does not allow deleting folders at the provider.', code: 'POLICY_FORBIDS' });
    const client = show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Projects' }));
    await screen.findByText('Delete Projects?');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete on server and in UniHub' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Folder not deleted', description: 'Your administrator does not allow deleting folders at the provider.' })));
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
      details: { deleted_on: ['alex@example.test'], remaining_on: [], settled: false, copies: [{ account_id: 'acc-1', email_address: 'alex@example.test', outcome: 'deleted' }] } });
    const client = show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await deleteOnServer('Projects');
    const result = await screen.findByRole('alertdialog', { name: 'Projects was deleted on the mail server' });
    expect(within(result).getByText('UniHub could not update its own copy yet. Delete the folder again to finish.')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalled();
  });

  // Created again under the name since the list was read (409 FOLDER_CHANGED): nothing was deleted anywhere.
  it('a folder that changed on the server since it was shown is not deleted, and the folders are read again', async () => {
    vi.mocked(api.delete).mockResolvedValue({ status: 409, error: 'The folder changed on the mail server (alex@example.test) since it was shown. Nothing was deleted there. Refresh the folders and try again.',
      code: 'FOLDER_CHANGED', details: { changed_on: ['alex@example.test'] } });
    const client = show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await deleteOnServer('Projects');
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Folder not deleted',
      description: 'The folder changed on the mail server (alex@example.test) since it was shown. Nothing was deleted there. Refresh the folders and try again.' })));
    expect(invalidate).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
