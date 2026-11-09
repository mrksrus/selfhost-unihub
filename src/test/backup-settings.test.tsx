import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { api } from '@/lib/api';
import { copyText, downloadTicket, saveFile } from '@/lib/platform';
import BackupSettings from '@/components/settings/BackupSettings';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { AuthContext, type AuthContextType } from '@/contexts/auth-context';
import type { BackupCapabilities, BackupJob, RestoreJob } from '@/lib/backup-api';
import { OWNER, mountSignedIn, policiesAnswer, stubBrowserApis, testClient } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-ada' } }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), uploadBlob: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));
vi.mock('@/lib/platform', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), downloadTicket: vi.fn(), saveFile: vi.fn().mockResolvedValue(undefined), copyText: vi.fn().mockResolvedValue(true) }));
// The reveal's deadline, shortened: the real one waits 20 seconds.
vi.mock('@/lib/backup-api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/backup-api')>();
  return { ...actual, revealRecoveryPasswordOnce: (id: string) => actual.revealRecoveryPasswordOnce(id, 1500) };
});

const SECTIONS = [{ id: 'settings', label: 'Settings' }, { id: 'contacts', label: 'Contacts' }, { id: 'calendar', label: 'Calendar and ToDo' }, { id: 'mail', label: 'Mail' }, { id: 'recordings', label: 'Recordings' }];
const capabilities = (download_mail: Partial<BackupCapabilities['download_mail']> = {}): BackupCapabilities => ({
  enabled: true, version: 7, sections: SECTIONS, export_sections: [...SECTIONS, { id: 'accounts', label: 'Account settings' }], exclusions: [],
  download_mail: { value: true, forced: false, reason: null, forced_account_ids: [], ...download_mail },
});
const job = (id: string, fields: Partial<BackupJob> = {}): BackupJob => ({
  id, scope: 'full', status: 'ready', phase: 'done', progress: 100, cancel_requested: false, requested_sections: [], file_size: 12_400_000, file_sha256: 'abc', content_type: 'application/vnd.unihub.backup',
  encryption_enabled: true, backup_uuid: `uuid-${id}`, recovery_password_available: false, recovery_password_revealed: true, server_unlock_available: true, keep_until: null,
  contents: { included: ['local', 'config'], left_out: [{ section: 'mail', what: 'Sync-mode mail', reason: 'It downloads again from the provider after the account reconnects.', count: 1204 }], notes: [] },
  error: null, created_at: '2026-06-03T10:00:00.000Z', updated_at: '2026-06-03T10:05:00.000Z', started_at: '2026-06-03T10:00:00.000Z', completed_at: '2026-06-03T10:05:00.000Z', downloaded_at: null, ...fields,
});
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
const JOBS = [
  // Ten days old: a 90-day minimum holds it (backup.server_retention_days). Its stored keep_until is the rule of the day it was made and must not decide.
  job('new', { created_at: daysAgo(10), started_at: daysAgo(10), completed_at: daysAgo(10), updated_at: daysAgo(10), keep_until: '2099-07-03T10:00:00.000Z', downloaded_at: daysAgo(9) }),
  job('old', { encryption_enabled: false, contents: null, content_type: 'application/zip', created_at: daysAgo(200), completed_at: daysAgo(200) }),
];
const restoreJob = (id: string, fields: Partial<RestoreJob> = {}): RestoreJob => ({
  id, source_type: 'generated', source_export_job_id: 'new', status: 'validated', operation: 'validate', phase: 'validated', progress: 100, cancel_requested: false,
  requested_sections: ['full'], conflict_mode: 'keep_existing', calendar_mode: 'merge_same_name', credentials_mode: 'keep_existing', archive_available: true, archive_size: 1000, archive_sha256: null,
  backup_uuid: null, is_encrypted: true, result_counts: null, error: null, attempt_count: 1, created_at: '2026-06-14T10:00:00.000Z', started_at: null, completed_at: null, expires_at: null,
  validation_result: { dry_run: true, valid: true, errors: [], warnings: [], counts: { contacts: 7 }, notes: [] }, ...fields,
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(answer => { resolve = answer; }); return { promise, resolve }; };
/** The real session provider: unmounting it ends the session the way an account switch does. */
const mountInSession = (view: React.ReactElement) => render(
  <AuthContext.Provider value={{ user: OWNER, isOffline: false } as unknown as AuthContextType}>
    <SessionQueryProvider privateSession><MemoryRouter>{view}</MemoryRouter></SessionQueryProvider>
  </AuthContext.Provider>,
);

function answer(caps = capabilities(), jobs = JOBS, restoreJobs: RestoreJob[] = [], policies = policiesAnswer()) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/backup/capabilities') return { data: caps };
    if (path === '/backup/jobs') return { data: { jobs } };
    if (path === '/backup/restore-jobs') return { data: { jobs: restoreJobs } };
    if (path === '/policies/effective') return policies;
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.post).mockResolvedValue({ data: { job: job('started', { status: 'queued', progress: 0 }) } });
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Settings → Backup and restore (0.28)', () => {
  it('offers no encryption choice and creates a backup with the downloaded-mail choice', { timeout: 20_000 }, async () => {
    answer();
    mountSignedIn(<BackupSettings active />);
    const create = await screen.findByRole('button', { name: 'Create backup' });
    await waitFor(() => expect(create).toBeEnabled());
    expect(screen.queryByRole('switch', { name: /encrypt/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Every backup is encrypted/)).toBeInTheDocument();
    const mail = screen.getByRole('switch', { name: 'Include downloaded mail' });
    expect(mail).toBeChecked();
    fireEvent.click(create);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/jobs', { sections: 'full', include_download_mail: true }));
    fireEvent.click(mail);
    // The ledger follows the choice.
    expect(screen.getByText('Downloaded mail and mail of Sync-mode accounts')).toBeInTheDocument();
    const createSection = screen.getByRole('heading', { name: 'Create a backup' }).closest('section')!;
    fireEvent.click(within(createSection).getByRole('button', { name: 'Contacts' }));
    fireEvent.click(create);
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/backup/jobs', { sections: ['contacts'], include_download_mail: false }));
    // The connection-only backup the server offers (mail and calendar accounts without their content) stays a choice.
    fireEvent.click(within(createSection).getByRole('button', { name: 'Contacts' }));
    fireEvent.click(within(createSection).getByRole('button', { name: 'Account settings' }));
    fireEvent.click(create);
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/backup/jobs', { sections: ['accounts'], include_download_mail: false }));
  });

  it('a forced downloaded-mail choice is checked and greyed with the reason, and a forbidden create greys the button', async () => {
    const REASON = 'Your backups always include downloaded mail, as your administrator requires.';
    const CREATE = 'Your administrator does not allow creating backups.';
    answer(capabilities({ value: true, forced: true, reason: REASON }), JOBS, [], policiesAnswer({ 'backup.create': { value: 'forbidden', reason: CREATE } }));
    mountSignedIn(<BackupSettings active />);
    const mail = await screen.findByRole('switch', { name: 'Include downloaded mail' });
    await waitFor(() => expect(mail).toBeDisabled());
    expect(mail).toBeChecked();
    expect(screen.getByText(REASON)).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create backup' });
    await waitFor(() => expect(create).toBeDisabled());
    expect(screen.getByText(CREATE)).toBeInTheDocument();
  });

  it('lists what each backup left out, how long the administrator keeps it, and marks archives from before 0.28', async () => {
    answer();
    mountSignedIn(<BackupSettings active />);
    const section = (await screen.findByRole('heading', { name: 'Backups on this server' })).closest('section')!;
    await waitFor(() => expect(within(section).getAllByText('Full backup')).toHaveLength(2));
    expect(within(section).getByText('Left out: Sync-mode mail (1,204).')).toBeInTheDocument();
    // No minimum in force: nothing is "kept at least until", whatever the job stored when it was made.
    expect(within(section).queryByText(/kept at least until/)).not.toBeInTheDocument();
    expect(within(section).getByText('Not encrypted, made before 0.28.')).toBeInTheDocument();
    // P-35: a downloaded, encrypted backup says how to open it outside UniHub; the plain pre-0.28 one does not.
    const hints = within(section).getAllByTestId('open-outside-hint');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toHaveTextContent(/password-protected ZIP file\. Open it with 7-Zip, Keka or WinRAR/);
    expect(within(hints[0]).getByRole('list')).toHaveTextContent(/unihub-backup\.zip/);
    expect(within(section).queryByText(/removes|deleted on its own|automatically deleted/)).not.toBeInTheDocument();
  });

  it('falls back to a .zip file name when the ticket names none', async () => {
    answer(capabilities(), [job('named', { downloaded_at: '2026-06-03T11:00:00.000Z' })]);
    vi.mocked(api.post).mockResolvedValueOnce({ data: { url: '/api/files/tickets/t3/download', expires_at: '', filename: '', content_type: 'application/zip', size: 1 } });
    mountSignedIn(<BackupSettings active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Full backup' }));
    await waitFor(() => expect(downloadTicket).toHaveBeenCalledWith({ url: '/api/files/tickets/t3/download', filename: 'unihub-backup-named.zip' }));
  });

  // backup.server_retention_days: the administrator's days are a minimum. Delete greys out on a backup
  // younger than that with the date it opens; an older one deletes as before.
  it('greys Delete out on a backup the administrator still keeps, with the date it can go, and not on an older one', { timeout: 20_000 }, async () => {
    answer(capabilities(), JOBS, [], policiesAnswer({ 'backup.server_retention_days': { value: 90, allowed: true, reason: 'Your backups are kept at least 90 days: until then nobody can delete them.' } }));
    mountSignedIn(<BackupSettings active />);
    const section = (await screen.findByRole('heading', { name: 'Backups on this server' })).closest('section')!;
    await waitFor(() => expect(within(section).getAllByText('Full backup')).toHaveLength(2));
    expect(screen.getByText(/keeps each backup at least 90 days; after that you can delete it/)).toBeInTheDocument();
    const [newer, older] = within(section).getAllByRole('button', { name: 'More actions for Full backup' });
    fireEvent.pointerDown(newer, { button: 0, ctrlKey: false });
    const held = await screen.findByRole('menuitem', { name: /Delete/ });
    expect(held).toHaveAttribute('aria-disabled', 'true');
    const opens = formatDay(new Date(Date.parse(JOBS[0].created_at) + 90 * DAY).toISOString());
    expect(held).toHaveTextContent(`at least 90 days: until then nobody can delete them. This one can be deleted from ${opens}`);
    expect(within(section).getByText(new RegExp(`kept at least until ${opens}`))).toBeInTheDocument();
    fireEvent.click(held);
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.keyDown(held, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem')).not.toBeInTheDocument());
    // The old backup was made 200 days ago: nothing holds it.
    fireEvent.pointerDown(older, { button: 0, ctrlKey: false });
    const free = await screen.findByRole('menuitem', { name: 'Delete' });
    expect(free).not.toHaveAttribute('aria-disabled');
    fireEvent.click(free);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/backup/jobs/old'));
  });

  // The rule in force today decides, not the one of the day the backup was made:
  // the server tests the current minimum against the creation date.
  it('Delete follows the current minimum after the rule was removed, shortened or lengthened', { timeout: 20_000 }, async () => {
    const deleteItem = async (name: string) => {
      fireEvent.pointerDown(await screen.findByRole('button', { name: `More actions for ${name}` }), { button: 0, ctrlKey: false });
      return screen.findByRole('menuitem', { name: /Delete/ });
    };
    const close = async (item: HTMLElement) => { fireEvent.keyDown(item, { key: 'Escape' }); await waitFor(() => expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()); };
    // Removed: the 10-day-old backup still carries a keep_until of 2099, yet Delete is allowed.
    answer(capabilities(), [JOBS[0]]);
    const first = mountSignedIn(<BackupSettings active />);
    expect(await screen.findByText(/The server keeps them until you delete them/)).toBeInTheDocument();
    let item = await deleteItem('Full backup');
    expect(item).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(/kept at least until/)).not.toBeInTheDocument();
    await close(item);
    first.unmount();
    // Shortened to 30 days: a 60-day-old backup with a far keep_until is free.
    answer(capabilities(), [job('sixty', { created_at: daysAgo(60), completed_at: daysAgo(60), keep_until: '2099-07-03T10:00:00.000Z' })], [],
      policiesAnswer({ 'backup.server_retention_days': { value: 30, allowed: true, reason: 'Your backups are kept at least 30 days.' } }));
    const second = mountSignedIn(<BackupSettings active />);
    await screen.findByText(/keeps each backup at least 30 days/);
    item = await deleteItem('Full backup');
    expect(item).not.toHaveAttribute('aria-disabled');
    await close(item);
    second.unmount();
    // Lengthened to 365 days: a 100-day-old backup whose stored keep_until has passed is held until its creation plus 365 days.
    const created = daysAgo(100);
    answer(capabilities(), [job('hundred', { created_at: created, completed_at: created, keep_until: daysAgo(10) })], [],
      policiesAnswer({ 'backup.server_retention_days': { value: 365, allowed: true, reason: 'Your backups are kept at least 365 days.' } }));
    mountSignedIn(<BackupSettings active />);
    await screen.findByText(/keeps each backup at least 365 days/);
    item = await deleteItem('Full backup');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent(`This one can be deleted from ${formatDay(new Date(Date.parse(created) + 365 * DAY).toISOString())}`);
    fireEvent.click(item);
    expect(api.delete).not.toHaveBeenCalled();
  });

  // A rule the page did not know yet: the server refuses, its words are shown and rules and backups are read again.
  it('a delete the server refuses under a rule shows the server\'s reason and reloads the rules', { timeout: 20_000 }, async () => {
    answer(capabilities(), [JOBS[1]]);
    vi.mocked(api.delete).mockResolvedValueOnce({ error: 'Your administrator keeps every backup at least 90 days. This one can be deleted from 2026-12-01.', status: 403, code: 'POLICY_FORBIDS' });
    mountSignedIn(<BackupSettings active />);
    await screen.findByText('Full backup');
    const before = vi.mocked(api.get).mock.calls.filter(([path]) => path === '/policies/effective').length;
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for Full backup' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not delete the backup', description: expect.stringContaining('at least 90 days') })));
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.filter(([path]) => path === '/policies/effective').length).toBeGreaterThan(before));
  });

  it('downloads a backup through a download ticket, never with the session URL', async () => {
    answer();
    vi.mocked(api.post).mockResolvedValueOnce({ data: { url: '/api/files/tickets/t1/download', expires_at: '2026-06-15T09:31:00.000Z', filename: 'unihub-backup-new.zip', content_type: 'application/zip', size: 12_400_000 } });
    mountSignedIn(<BackupSettings active />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Download Full backup' }))[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/files/tickets', { kind: 'backup-archive', id: 'new' }));
    await waitFor(() => expect(downloadTicket).toHaveBeenCalledWith({ url: '/api/files/tickets/t1/download', filename: 'unihub-backup-new.zip' }));
  });

  it('a download ticket answered after the session ended starts no download', { timeout: 20_000 }, async () => {
    answer();
    const ticket = deferred<{ data: unknown }>();
    vi.mocked(api.post).mockImplementation(() => ticket.promise as never);
    const mounted = mountInSession(<BackupSettings active />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Download Full backup' }))[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/files/tickets', { kind: 'backup-archive', id: 'new' }));
    mounted.unmount();
    await act(async () => ticket.resolve({ data: { url: '/api/files/tickets/late/download', filename: 'late.unihub-backup', expires_at: '', content_type: '', size: 1 } }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(downloadTicket).not.toHaveBeenCalled();
  });

  it('the recovery dialog cannot be dismissed while the password is being revealed', { timeout: 20_000 }, async () => {
    answer(capabilities(), [job('a', { recovery_password_available: true, recovery_password_revealed: false }), job('b', { recovery_password_available: true, recovery_password_revealed: false })]);
    const reveal = deferred<{ data: unknown }>();
    vi.mocked(api.post).mockImplementation(async (path: string) => path === '/backup/jobs/a/recovery-password/reveal' ? reveal.promise as never : { data: { url: '/api/files/tickets/t/download', filename: 'f', expires_at: '', content_type: '', size: 1 } });
    mountSignedIn(<BackupSettings active />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Download Full backup' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Recovery password' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the password' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/jobs/a/recovery-password/reveal', undefined, expect.anything()));
    // The server reveals it once: Cancel, Escape and a click outside keep the dialog until it is shown and saved.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Recovery password' })).toBeInTheDocument();
    await act(async () => reveal.resolve({ data: { recovery_password: 'password-of-a' } }));
    expect(await within(dialog).findByLabelText('Recovery password')).toHaveTextContent('password-of-a');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download backup' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/files/tickets', { kind: 'backup-archive', id: 'a' }));
    expect(api.post).not.toHaveBeenCalledWith('/files/tickets', { kind: 'backup-archive', id: 'b' });
  });

  it('a restore runs only with the choices it was prepared with', { timeout: 20_000 }, async () => {
    answer();
    const prepare = deferred<{ data: unknown }>();
    vi.mocked(api.post).mockImplementation(async (path: string) => path === '/backup/jobs/new/restore' ? prepare.promise as never : { data: {} });
    mountSignedIn(<BackupSettings active />);
    const matching = await screen.findByRole('combobox', { name: 'Matching items' });
    fireEvent.click(matching);
    fireEvent.click(await screen.findByRole('option', { name: 'Replace with the backup' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore Full backup' })[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/jobs/new/restore', expect.objectContaining({ conflict_mode: 'replace' })));
    // The choices are fixed while the server prepares the job with them.
    expect(matching).toBeDisabled();
    const replaced = restoreJob('r', { conflict_mode: 'replace' });
    answer(capabilities(), JOBS, [replaced]);
    await act(async () => prepare.resolve({ data: { job: replaced } }));
    const section = screen.getByRole('heading', { name: 'Restore' }).closest('section')!;
    const start = within(section).getByRole('button', { name: 'Restore' });
    await waitFor(() => expect(start).toBeEnabled());
    expect(matching).toHaveTextContent('Replace with the backup');
    // Changing a choice afterwards drops the prepared job: what the screen says is what runs.
    fireEvent.click(matching);
    fireEvent.click(await screen.findByRole('option', { name: 'Keep what is here' }));
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(api.post).not.toHaveBeenCalledWith('/backup/restore-jobs/r/start');
    // Choosing the prepared job in the list shows its choices again, and Restore opens with them.
    fireEvent.click(screen.getByRole('button', { name: /From a backup on this server/ }));
    expect(matching).toHaveTextContent('Replace with the backup');
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Restore this backup?' })).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/restore-jobs/r/start'));
  });

  it('every start, from any button, confirms the choices the job was prepared with', { timeout: 20_000 }, async () => {
    const replaced = restoreJob('r', { conflict_mode: 'replace', credentials_mode: 'restore' });
    const failed = restoreJob('f', { status: 'failed', source_type: 'upload', error: 'Lost the connection', validation_result: null });
    answer(capabilities(), JOBS, [replaced, failed]);
    vi.mocked(api.post).mockResolvedValue({ data: { job: replaced } });
    mountSignedIn(<BackupSettings active />);
    const matching = await screen.findByRole('combobox', { name: 'Matching items' });
    expect(matching).toHaveTextContent('Keep what is here');
    // The row's Restore does not start the job: it asks first, with the job's own stored choices.
    await screen.findByRole('button', { name: /From a backup on this server/ });
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1]);
    const ask = await screen.findByRole('alertdialog', { name: 'Restore this backup?' });
    expect(api.post).not.toHaveBeenCalledWith('/backup/restore-jobs/r/start');
    const choices = within(ask).getByLabelText('The job\'s choices');
    expect(choices).toHaveTextContent('Matching itemsReplace with the backup');
    expect(choices).toHaveTextContent('Account sign-insUse the backup\'s');
    expect(matching).toHaveTextContent('Replace with the backup');
    fireEvent.click(within(ask).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalledWith('/backup/restore-jobs/r/start');
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1]);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/restore-jobs/r/start'));
    // Try again asks the same way.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('alertdialog', { name: 'Restore this backup?' })).toHaveTextContent('From an uploaded backup');
    expect(api.post).not.toHaveBeenCalledWith('/backup/restore-jobs/f/start');
  });

  it('a reveal the server does not answer in time says so and lets the person out', { timeout: 20_000 }, async () => {
    answer(capabilities(), [job('a', { recovery_password_available: true, recovery_password_revealed: false })]);
    vi.mocked(api.post).mockImplementation(() => new Promise(() => {}) as never);
    mountSignedIn(<BackupSettings active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Full backup' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Recovery password' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the password' }));
    expect(await within(dialog).findByText('The server did not answer in time.', {}, { timeout: 10_000 })).toBeInTheDocument();
    // The server keeps its own key: the backup stays restorable here, and nothing advises deleting it.
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent(/may have counted this attempt/);
    expect(alert).toHaveTextContent(/this server can still restore this backup/);
    expect(alert).toHaveTextContent(/cannot be opened on another UniHub/);
    expect(alert).not.toHaveTextContent(/delete/i);
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeEnabled();
    // The dialog's own Close button, not the corner X (which carries the same name).
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).find(button => button.textContent === 'Close')!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recovery password' })).not.toBeInTheDocument());
  });

  it('a lost answer says the password may be gone, a used-up retry says what the backup is still good for, and the list says so', { timeout: 20_000 }, async () => {
    const jobs = [job('a', { recovery_password_available: true, recovery_password_revealed: false })];
    answer(capabilities(), jobs);
    let reveals = 0;
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (!path.endsWith('/recovery-password/reveal')) return { data: {} };
      // The server showed the password in its first answer, which never arrived; the second asks again.
      jobs.splice(0, 1, job('a', { recovery_password_available: false, recovery_password_revealed: true }));
      return ++reveals === 1 ? { error: 'Failed to fetch' } : { error: 'Recovery password has already been revealed', status: 410 };
    });
    mountSignedIn(<BackupSettings active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Full backup' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Recovery password' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the password' }));
    const alert = await within(dialog).findByRole('alert', {}, { timeout: 10_000 });
    expect(alert).toHaveTextContent(/The answer was lost/);
    expect(alert).toHaveTextContent(/may have counted this attempt/);
    expect(alert).toHaveTextContent(/this server can still restore this backup/);
    expect(alert).not.toHaveTextContent(/delete/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await within(dialog).findByText(/already shown and cannot be shown again/, {}, { timeout: 10_000 });
    const after = within(dialog).getByRole('alert');
    expect(after).toHaveTextContent(/this server can still restore this backup/);
    expect(after).toHaveTextContent(/create a new backup/);
    expect(after).not.toHaveTextContent(/delete/i);
    expect(within(dialog).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).find(button => button.textContent === 'Close')!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recovery password' })).not.toBeInTheDocument());
    // The list is honest about the backup whose password never reached the person.
    expect(await screen.findByText(/Its recovery password was not received/, {}, { timeout: 10_000 })).toBeInTheDocument();
  });

  it('a file save that finishes after its dialog closed acknowledges nothing for the next backup', { timeout: 20_000 }, async () => {
    answer(capabilities(), [job('a', { recovery_password_available: true, recovery_password_revealed: false }), job('b', { recovery_password_available: true, recovery_password_revealed: false })]);
    vi.mocked(api.post).mockImplementation(async (path: string) => ({ data: { recovery_password: path.includes('/jobs/a/') ? 'password-of-a' : 'password-of-b' } }));
    const save = deferred<void>();
    vi.mocked(saveFile).mockReturnValueOnce(save.promise);
    vi.mocked(copyText).mockResolvedValue(true);
    mountSignedIn(<BackupSettings active />);
    // A: reveal, start a save that stays pending (the app's bridge can take long), copy, close.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Download Full backup' }, { timeout: 10_000 }))[0]);
    let dialog = await screen.findByRole('dialog', { name: 'Recovery password' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the password' }));
    await within(dialog).findByText('password-of-a');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save as file' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(within(dialog).getByRole('checkbox')).toBeChecked());
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).find(button => button.textContent === 'Close')!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recovery password' })).not.toBeInTheDocument());
    // B: revealed, not yet saved. A's save finishing now must not count for B.
    fireEvent.click(screen.getAllByRole('button', { name: 'Download Full backup' })[1]);
    dialog = await screen.findByRole('dialog', { name: 'Recovery password' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the password' }));
    await within(dialog).findByText('password-of-b');
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    await act(async () => save.resolve());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Download backup' })).toBeDisabled();
    expect(vi.mocked(saveFile).mock.calls.map(call => call[1])).toEqual(['unihub-backup-a-recovery-password.txt']);
  });

  it('shows the recovery password once before the first download and waits until it is saved', { timeout: 20_000 }, async () => {
    answer(capabilities(), [job('fresh', { recovery_password_available: true, recovery_password_revealed: false })]);
    vi.mocked(api.post).mockImplementation(async (path: string) => path.endsWith('/recovery-password/reveal') ? { data: { recovery_password: 'correct-horse-battery' } } : { data: { url: '/api/files/tickets/t2/download', filename: 'f', expires_at: '', content_type: '', size: 1 } });
    const client = testClient();
    mountSignedIn(<BackupSettings active />, { client });
    fireEvent.click(await screen.findByRole('button', { name: 'Download Full backup' }));
    const dialog = await screen.findByRole('dialog', { name: 'Recovery password' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the password' }));
    expect(await within(dialog).findByLabelText('Recovery password')).toHaveTextContent('correct-horse-battery');
    const download = within(dialog).getByRole('button', { name: 'Download backup' });
    expect(download).toBeDisabled();
    expect(within(dialog).getByTestId('open-outside-hint')).toHaveTextContent(/Open it with 7-Zip, Keka or WinRAR and the recovery password/);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(download).toBeEnabled();
    fireEvent.click(download);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/files/tickets', { kind: 'backup-archive', id: 'fresh' }));
    // Closed: the password is gone from the page and from the query client's mutation state.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recovery password' })).not.toBeInTheDocument());
    expect(screen.queryByText('correct-horse-battery')).not.toBeInTheDocument();
    const retained = () => client.getMutationCache().getAll().some(mutation => JSON.stringify(mutation.state.data ?? null).includes('correct-horse-battery'));
    await waitFor(() => expect(retained()).toBe(false), { timeout: 10_000 });
  });

  it('the restore review says what the archive holds, what it left out and the server\'s notes, and a forbidden restore greys Restore', async () => {
    const RESTORE = 'Your administrator does not allow restoring backups.';
    const validated: RestoreJob = {
      id: 'r1', source_type: 'upload', source_export_job_id: null, status: 'validated', operation: 'validate', phase: 'validated', progress: 100, cancel_requested: false,
      requested_sections: ['full'], conflict_mode: 'keep_existing', calendar_mode: 'merge_same_name', credentials_mode: 'keep_existing', archive_available: true, archive_size: 1000, archive_sha256: null,
      backup_uuid: null, is_encrypted: true, result_counts: null, error: null, attempt_count: 1, created_at: '2026-06-14T10:00:00.000Z', started_at: null, completed_at: null, expires_at: null,
      validation_result: {
        dry_run: true, valid: true, errors: [], warnings: [], counts: { contacts: 7 },
        contents: { included: ['local', 'config'], left_out: [{ section: 'calendar', what: 'CalDAV events', reason: 'They sync again from the calendar server.', count: 88 }], notes: ['This backup was made before 0.28; mirrored data was left out when it was read.'] },
        // The server's result repeats the archive's notes; each shows once.
        notes: ['This backup was made before 0.28; mirrored data was left out when it was read.', '3 synced tasks keep their ToDo state once their calendars sync.'],
      },
    };
    answer(capabilities(), JOBS, [validated], policiesAnswer({ 'backup.restore': { value: 'forbidden', reason: RESTORE } }));
    mountSignedIn(<BackupSettings active />);
    fireEvent.click(await screen.findByRole('button', { name: /From an uploaded backup/ }));
    const review = await screen.findByLabelText('Backup review');
    expect(review).toHaveTextContent('The backup checks out');
    expect(review).toHaveTextContent('In the backup: Your contacts, local calendars, tasks and recordings and your settings and account sign-ins.');
    expect(review).toHaveTextContent('Left out: CalDAV events (88), they sync again from the calendar server');
    expect(within(review).getAllByText(/This backup was made before 0\.28/)).toHaveLength(1);
    expect(review).toHaveTextContent('3 synced tasks keep their ToDo state');
    const restoreButtons = screen.getAllByRole('button', { name: 'Restore' });
    await waitFor(() => { for (const button of restoreButtons) expect(button).toBeDisabled(); });
    expect(screen.getAllByText(RESTORE).length).toBeGreaterThan(0);
  });
});
