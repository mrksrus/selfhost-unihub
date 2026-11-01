import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { downloadTicket } from '@/lib/platform';
import BackupSettings from '@/components/settings/BackupSettings';
import type { BackupCapabilities, BackupJob, RestoreJob } from '@/lib/backup-api';
import { mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-ada' } }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), uploadBlob: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));
vi.mock('@/lib/platform', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), downloadTicket: vi.fn(), saveFile: vi.fn().mockResolvedValue(undefined) }));

const SECTIONS = [{ id: 'settings', label: 'Settings' }, { id: 'contacts', label: 'Contacts' }, { id: 'calendar', label: 'Calendar and ToDo' }, { id: 'mail', label: 'Mail' }, { id: 'recordings', label: 'Recordings' }];
const capabilities = (download_mail: Partial<BackupCapabilities['download_mail']> = {}): BackupCapabilities => ({
  enabled: true, version: 7, sections: SECTIONS, exclusions: [],
  download_mail: { value: true, forced: false, reason: null, forced_account_ids: [], ...download_mail },
});
const job = (id: string, fields: Partial<BackupJob> = {}): BackupJob => ({
  id, scope: 'full', status: 'ready', phase: 'done', progress: 100, cancel_requested: false, requested_sections: [], file_size: 12_400_000, file_sha256: 'abc', content_type: 'application/vnd.unihub.backup',
  encryption_enabled: true, backup_uuid: `uuid-${id}`, recovery_password_available: false, recovery_password_revealed: true, server_unlock_available: true, keep_until: null,
  contents: { included: ['local', 'config'], left_out: [{ section: 'mail', what: 'Sync-mode mail', reason: 'It downloads again from the provider after the account reconnects.', count: 1204 }], notes: [] },
  error: null, created_at: '2026-06-03T10:00:00.000Z', updated_at: '2026-06-03T10:05:00.000Z', started_at: '2026-06-03T10:00:00.000Z', completed_at: '2026-06-03T10:05:00.000Z', downloaded_at: null, ...fields,
});
const JOBS = [
  job('new', { keep_until: '2026-07-03T10:00:00.000Z' }),
  job('old', { encryption_enabled: false, contents: null, content_type: 'application/zip', created_at: '2026-05-01T10:00:00.000Z', completed_at: '2026-05-01T10:05:00.000Z' }),
];

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
  it('offers no encryption choice and creates a backup with the downloaded-mail choice', async () => {
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

  it('lists what each backup left out, when the server removes it, and marks archives from before 0.28', async () => {
    answer();
    mountSignedIn(<BackupSettings active />);
    const section = (await screen.findByRole('heading', { name: 'Backups on this server' })).closest('section')!;
    await waitFor(() => expect(within(section).getAllByText('Full backup')).toHaveLength(2));
    expect(within(section).getByText('Left out: Sync-mode mail (1,204).')).toBeInTheDocument();
    expect(within(section).getByText(/kept until (3 July|July 3)/)).toBeInTheDocument();
    expect(within(section).getByText('Not encrypted, made before 0.28.')).toBeInTheDocument();
  });

  it('downloads a backup through a download ticket, never with the session URL', async () => {
    answer();
    vi.mocked(api.post).mockResolvedValueOnce({ data: { url: '/api/files/tickets/t1/download', expires_at: '2026-06-15T09:31:00.000Z', filename: 'unihub-backup-new.unihub-backup', content_type: 'application/vnd.unihub.backup', size: 12_400_000 } });
    mountSignedIn(<BackupSettings active />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Download Full backup' }))[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/files/tickets', { kind: 'backup-archive', id: 'new' }));
    await waitFor(() => expect(downloadTicket).toHaveBeenCalledWith({ url: '/api/files/tickets/t1/download', filename: 'unihub-backup-new.unihub-backup' }));
  });

  it('shows the recovery password once before the first download and waits until it is saved', async () => {
    answer(capabilities(), [job('fresh', { recovery_password_available: true, recovery_password_revealed: false })]);
    vi.mocked(api.post).mockImplementation(async (path: string) => path.endsWith('/recovery-password/reveal') ? { data: { recovery_password: 'correct-horse-battery' } } : { data: { url: '/api/files/tickets/t2/download', filename: 'f', expires_at: '', content_type: '', size: 1 } });
    mountSignedIn(<BackupSettings active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Full backup' }));
    const dialog = await screen.findByRole('dialog', { name: 'Recovery password' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the password' }));
    expect(await within(dialog).findByLabelText('Recovery password')).toHaveTextContent('correct-horse-battery');
    const download = within(dialog).getByRole('button', { name: 'Download backup' });
    expect(download).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(download).toBeEnabled();
    fireEvent.click(download);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/files/tickets', { kind: 'backup-archive', id: 'fresh' }));
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
        notes: ['3 synced tasks keep their ToDo state once their calendars sync.'],
      },
    };
    answer(capabilities(), JOBS, [validated], policiesAnswer({ 'backup.restore': { value: 'forbidden', reason: RESTORE } }));
    mountSignedIn(<BackupSettings active />);
    fireEvent.click(await screen.findByRole('button', { name: /From an uploaded backup/ }));
    const review = await screen.findByLabelText('Backup review');
    expect(review).toHaveTextContent('The backup checks out');
    expect(review).toHaveTextContent('In the backup: Your contacts, local calendars, tasks and recordings and your settings and account sign-ins.');
    expect(review).toHaveTextContent('Left out: CalDAV events (88), they sync again from the calendar server');
    expect(review).toHaveTextContent('This backup was made before 0.28');
    expect(review).toHaveTextContent('3 synced tasks keep their ToDo state');
    const restoreButtons = screen.getAllByRole('button', { name: 'Restore' });
    await waitFor(() => { for (const button of restoreButtons) expect(button).toBeDisabled(); });
    expect(screen.getAllByText(RESTORE).length).toBeGreaterThan(0);
  });
});
