import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, LockKeyhole, MoreHorizontal, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useToast } from '@/hooks/use-toast';
import {
  addAdminCalendarAccount, addAdminMailAccount, adminUserQueryKeys, adminUsersQueryKey, clearAdminUserModule, deleteAdminUserBackup, emptyAdminUserBin,
  fetchAdminUserAccounts, fetchAdminUserBackups, fetchAdminUsers, removeAdminCalendarAccount, removeAdminMailAccount, updateAdminCalendarAccount, updateAdminMailAccount,
  type AdminCalendarAccount, type AdminClearModule, type AdminMailAccount,
} from '@/lib/admin-api';
import { BIN_MODULES, type BinModule } from '@/lib/bin-api';
import type { BackupJob } from '@/lib/backup-api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import { AdminCalendarAccountDialog, AdminMailAccountDialog } from '@/components/admin/AdminAccountDialogs';

// Admin → Users → a person: their mail and calendar accounts, backups, bin
// and data (F13, accounts.admin_manage). A rule that forbids the person an
// action never makes it impossible: the administrator does it here, with
// their own password, and the activity log records it. The routes call the
// same services as the person's own, and check the person's modules and
// restore locks.
//
// Every action is bound to the person it was opened for: the confirmation
// holds their id, the request takes it from its variables, and a change of
// the route closes every dialog. A dialog has a generation, counted up each
// time one opens: an answer closes only the dialog it was submitted from,
// never one opened since for someone else. The administrator's password is
// a request variable only for as long as the request runs
// (useSecretMutation).

const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const formatBytes = (bytes: number) => bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const CLEAR_TARGETS: { module: AdminClearModule; label: string; consequence: string }[] = [
  { module: 'contacts', label: 'Contacts', consequence: 'Every contact of this person is deleted.' },
  { module: 'calendar', label: 'Calendar and ToDo', consequence: 'Every event and task of this person is deleted.' },
  { module: 'mail-accounts', label: 'Mail accounts', consequence: 'Every mail account of this person and its mail in UniHub is deleted. Mail at the providers is not touched.' },
  { module: 'recordings', label: 'Recordings', consequence: 'Every recording of this person is deleted.' },
];

type Confirm = { userId: string; generation: number; title: string; description: string; action: string; destructive?: boolean; run: (password: string, generation: number) => void };
type For<T> = T & { userId: string; password: string; generation: number };
type AccountDialog<A> = { open: boolean; account: A | null; generation: number };
const CLOSED = { open: false, account: null, generation: 0 };

function mailMeta(account: AdminMailAccount) {
  return [account.sync_mode === 'download' ? (account.delete_emails_on_server ? 'Download, deletes at the provider' : 'Download') : 'Sync',
    account.disconnected_at ? 'disconnected, mail kept' : !account.is_active ? 'paused' : account.sync_status ?? null,
    account.last_synced_at ? `synced ${formatWhen(account.last_synced_at)}` : null].filter(Boolean).join(' · ');
}
function calendarMeta(account: AdminCalendarAccount) {
  return [account.provider === 'caldav' ? 'CalDAV' : account.provider === 'ics' ? 'Subscription' : 'Local calendars', account.account_email,
    !account.is_active ? 'paused' : account.sync_status ?? null, account.mail_account_id ? 'from a mail account' : null].filter(Boolean).join(' · ');
}

const AdminUserDetail = () => {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const admin = user?.role === 'admin';
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [mailDialog, setMailDialog] = useState<AccountDialog<AdminMailAccount>>(CLOSED);
  const [calendarDialog, setCalendarDialog] = useState<AccountDialog<AdminCalendarAccount>>(CLOSED);
  const generations = useRef(0);
  const openConfirm = (spec: Omit<Confirm, 'generation'>) => setConfirm({ ...spec, generation: ++generations.current });
  const openMailDialog = (account: AdminMailAccount | null) => setMailDialog({ open: true, account, generation: ++generations.current });
  const openCalendarDialog = (account: AdminCalendarAccount | null) => setCalendarDialog({ open: true, account, generation: ++generations.current });
  const closeConfirm = (generation: number) => setConfirm(current => (current?.generation === generation ? null : current));
  const closeMailDialog = (generation: number) => setMailDialog(current => (current.generation === generation ? CLOSED : current));
  const closeCalendarDialog = (generation: number) => setCalendarDialog(current => (current.generation === generation ? CLOSED : current));

  const usersQuery = useQuery({ queryKey: adminUsersQueryKey, queryFn: ({ signal }) => fetchAdminUsers(signal), enabled: admin });
  const person = usersQuery.data?.find(entry => entry.id === id) ?? null;
  const accountsQuery = useQuery({ queryKey: adminUserQueryKeys.accounts(id), queryFn: ({ signal }) => fetchAdminUserAccounts(id, signal), enabled: admin && !!id });
  const backupsQuery = useQuery({ queryKey: adminUserQueryKeys.backups(id), queryFn: ({ signal }) => fetchAdminUserBackups(id, signal), enabled: admin && !!id });
  const refreshAccounts = (userId: string) => { void client.invalidateQueries({ queryKey: adminUserQueryKeys.accounts(userId) }); };
  const refreshBackups = (userId: string) => { void client.invalidateQueries({ queryKey: adminUserQueryKeys.backups(userId) }); };
  const done = (title: string, generation: number, refresh: () => void) => { refresh(); closeConfirm(generation); toast({ title }); };
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });
  // Another person's page: nothing opened for the previous one may stay.
  useEffect(() => { setConfirm(null); setMailDialog(CLOSED); setCalendarDialog(CLOSED); }, [id]);

  const saveMail = useSecretMutation({
    mutationFn: ({ userId, account, fields, password }: For<{ account: AdminMailAccount | null; fields: Parameters<typeof updateAdminMailAccount>[2] }>) =>
      account ? updateAdminMailAccount(userId, account.id, fields, password) : addAdminMailAccount(userId, fields as Parameters<typeof addAdminMailAccount>[1], password),
    onSuccess: (_result, { userId, account, generation }) => { refreshAccounts(userId); closeMailDialog(generation); toast({ title: account ? 'Mail account changed' : 'Mail account added' }); },
    onError: failed('Could not save the mail account'),
  });
  const saveCalendar = useSecretMutation({
    mutationFn: ({ userId, account, fields, password }: For<{ account: AdminCalendarAccount | null; fields: Parameters<typeof updateAdminCalendarAccount>[2] }>) =>
      account ? updateAdminCalendarAccount(userId, account.id, fields, password) : addAdminCalendarAccount(userId, fields as Parameters<typeof addAdminCalendarAccount>[1], password),
    onSuccess: (_result, { userId, account, generation }) => { refreshAccounts(userId); closeCalendarDialog(generation); toast({ title: account ? 'Calendar account changed' : 'Calendar account added' }); },
    onError: failed('Could not save the calendar account'),
  });
  const removeMail = useSecretMutation({
    mutationFn: ({ userId, accountId, password, purge }: For<{ accountId: string; purge: boolean }>) => removeAdminMailAccount(userId, accountId, password, purge),
    onSuccess: (_result, { userId, purge, generation }) => done(purge ? 'Mail account removed with its mail' : 'Mail account disconnected', generation, () => refreshAccounts(userId)),
    onError: failed('Could not remove the mail account'),
  });
  const removeCalendar = useSecretMutation({
    mutationFn: ({ userId, accountId, password }: For<{ accountId: string }>) => removeAdminCalendarAccount(userId, accountId, password),
    onSuccess: (_result, { userId, generation }) => done('Calendar account removed', generation, () => refreshAccounts(userId)),
    onError: failed('Could not remove the calendar account'),
  });
  const removeBackup = useSecretMutation({
    mutationFn: ({ userId, jobId, password }: For<{ jobId: string }>) => deleteAdminUserBackup(userId, jobId, password),
    onSuccess: (_result, { userId, generation }) => done('Backup deleted', generation, () => refreshBackups(userId)),
    onError: failed('Could not delete the backup'),
  });
  const emptyBin = useSecretMutation({
    mutationFn: ({ userId, module, password }: For<{ module?: BinModule }>) => emptyAdminUserBin(userId, password, module),
    onSuccess: (deleted, { generation }) => done(deleted === 0 ? 'The bin was already empty' : `${deleted} ${deleted === 1 ? 'item' : 'items'} deleted for good`, generation, () => {}),
    onError: failed('Could not empty the bin'),
  });
  const clear = useSecretMutation({
    mutationFn: ({ userId, module, password }: For<{ module: AdminClearModule }>) => clearAdminUserModule(userId, module, password),
    onSuccess: (_result, { userId, module, generation }) => done(`${CLEAR_TARGETS.find(target => target.module === module)?.label} deleted`, generation, () => { refreshAccounts(userId); refreshBackups(userId); }),
    onError: failed('Could not delete the data'),
  });
  const pending = removeMail.isPending || removeCalendar.isPending || removeBackup.isPending || emptyBin.isPending || clear.isPending;

  const name = person?.full_name || person?.email || 'this person';
  // Every dialog names the person it acts for, with the address so that two people of one name stay apart.
  const target = person ? (person.full_name ? `${person.full_name} (${person.email})` : person.email) : name;
  const nothingAtAll = accountsQuery.data && backupsQuery.data && accountsQuery.data.mail_accounts.length === 0 && accountsQuery.data.calendar_accounts.length === 0 && backupsQuery.data.length === 0;
  const body = !admin ? <p className="text-sm text-muted-foreground">Only admins can see this page.</p>
    : usersQuery.isLoading ? <LoadingState label="Loading the account…" />
    : usersQuery.error ? <ErrorState title="Could not load the account" error={usersQuery.error} onRetry={() => void usersQuery.refetch()} retrying={usersQuery.isFetching} />
    : !person ? <ErrorState title="No such account" error="The account may have been deleted." />
    : (
      <>
        <p className="mb-8 max-w-prose text-sm text-muted-foreground">
          What you do here is done for {name} as if they did it, with your password, and recorded in the activity log. A rule that forbids them an action does not apply to you.
        </p>
        {nothingAtAll && (
          <p role="status" className="mb-8 max-w-prose text-sm text-muted-foreground">{name} has no mail or calendar accounts and no backups on this server yet. Their bin and data can still be emptied below.</p>
        )}

        <SettingsSection title="Mail accounts" action={<Button size="sm" variant="outline" onClick={() => openMailDialog(null)}><Plus aria-hidden="true" />Add mail account</Button>}>
          {accountsQuery.isLoading ? <SettingsBlock><LoadingState compact label="Loading accounts…" /></SettingsBlock>
            : accountsQuery.error ? <SettingsBlock><ErrorState title="Could not load the accounts" error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} retrying={accountsQuery.isFetching} /></SettingsBlock>
            : accountsQuery.data!.mail_accounts.length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">{name} has no mail accounts.</p></SettingsBlock>
            : accountsQuery.data!.mail_accounts.map(account => (
              <SettingsRow key={account.id} label={account.display_name ? `${account.display_name} (${account.email_address})` : account.email_address} description={mailMeta(account)}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${account.email_address}`}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openMailDialog(account)}>Change settings or password</DropdownMenuItem>
                    {!account.disconnected_at && <DropdownMenuItem onClick={() => openConfirm({
                      userId: id, title: `Disconnect ${account.email_address}?`, description: 'Sync stops and the saved password is removed. Their mail stays in UniHub.', action: 'Disconnect',
                      run: (password, generation) => removeMail.mutate({ userId: id, generation, accountId: account.id, password, purge: false }) })}>Disconnect, keep mail</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => openConfirm({
                      userId: id, title: account.disconnected_at ? `Delete UniHub's copy of ${account.email_address}'s mail?` : `Remove ${account.email_address} with its mail?`,
                      description: 'UniHub\'s copy of the account, its mail, attachments and linked calendar is deleted. Mail at the provider is not touched.', action: 'Remove with its mail', destructive: true,
                      run: (password, generation) => removeMail.mutate({ userId: id, generation, accountId: account.id, password, purge: true }) })}>{account.disconnected_at ? 'Delete UniHub\'s copy of the mail' : 'Remove with its mail'}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SettingsRow>
            ))}
        </SettingsSection>

        <SettingsSection title="Calendar accounts" action={<Button size="sm" variant="outline" onClick={() => openCalendarDialog(null)}><Plus aria-hidden="true" />Add calendar account</Button>}>
          {accountsQuery.isLoading ? <SettingsBlock><LoadingState compact label="Loading accounts…" /></SettingsBlock>
            : accountsQuery.error ? null
            : accountsQuery.data!.calendar_accounts.length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">{name} has no calendar accounts.</p></SettingsBlock>
            : accountsQuery.data!.calendar_accounts.map(account => (
              <SettingsRow key={account.id} label={account.display_name || account.account_email || 'Calendars'} description={calendarMeta(account)}>
                {account.provider !== 'local' && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${account.display_name || account.account_email || 'the calendar account'}`}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {!account.mail_account_id && <DropdownMenuItem onClick={() => openCalendarDialog(account)}>Change settings or password</DropdownMenuItem>}
                      <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => openConfirm({
                        userId: id, title: `Remove ${account.display_name || account.account_email || 'this calendar account'}?`, description: 'Its calendars and events are removed from UniHub. Nothing is deleted on the calendar server.', action: 'Remove account', destructive: true,
                        run: (password, generation) => removeCalendar.mutate({ userId: id, generation, accountId: account.id, password }) })}>Remove account</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </SettingsRow>
            ))}
        </SettingsSection>

        <SettingsSection title="Backups" description="Backups kept on this server for this person. They cannot be downloaded here.">
          {backupsQuery.isLoading ? <SettingsBlock><LoadingState compact label="Loading backups…" /></SettingsBlock>
            : backupsQuery.error ? <SettingsBlock><ErrorState title="Could not load the backups" error={backupsQuery.error} onRetry={() => void backupsQuery.refetch()} retrying={backupsQuery.isFetching} /></SettingsBlock>
            : backupsQuery.data!.length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">{name} has no backups on this server.</p></SettingsBlock>
            : backupsQuery.data!.map((job: BackupJob) => (
              <SettingsRow key={job.id} label={<span className="flex items-center gap-1.5">{job.encryption_enabled && <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />}{job.scope === 'full' ? 'Full backup' : `${job.requested_sections.join(', ')} backup`}</span>}
                description={[job.status, formatWhen(job.completed_at || job.created_at), job.file_size ? formatBytes(job.file_size) : null, job.keep_until && Date.parse(job.keep_until) > Date.now() ? `kept at least until ${formatWhen(job.keep_until)}` : null].filter(Boolean).join(' · ')}>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={['queued', 'running', 'cancelling'].includes(job.status)} onClick={() => openConfirm({
                  userId: id, title: `Delete this backup of ${name}?`, description: `The archive is removed from the server${job.keep_until ? ', before the time your rule keeps it' : ''}. A copy they downloaded is not affected.`, action: 'Delete backup', destructive: true,
                  run: (password, generation) => removeBackup.mutate({ userId: id, generation, jobId: job.id, password }) })}>Delete</Button>
              </SettingsRow>
            ))}
        </SettingsSection>

        <SettingsSection title="Bin" description={`What ${name} deleted waits in their bin until it is restored or gone for good. Emptying it here is allowed whatever the bin rule says for them.`}>
          {BIN_MODULES.map(module => (
            <SettingsRow key={module.id} label={module.label}>
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => openConfirm({
                userId: id, title: `Empty the ${module.label.toLowerCase()} bin of ${name}?`, description: 'Everything in it is deleted for good and cannot be restored.', action: 'Delete for good', destructive: true,
                run: (password, generation) => emptyBin.mutate({ userId: id, generation, module: module.id, password }) })}>Empty</Button>
            </SettingsRow>
          ))}
          <SettingsRow label="Everything">
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => openConfirm({
              userId: id, title: `Empty the bin of ${name}?`, description: 'Everything in it is deleted for good and cannot be restored.', action: 'Delete for good', destructive: true,
              run: (password, generation) => emptyBin.mutate({ userId: id, generation, password }) })}>Empty bin</Button>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Delete data" description="The same as the person's Settings › Delete data. Only a backup brings it back.">
          {CLEAR_TARGETS.map(target => (
            <SettingsRow key={target.module} label={target.label}>
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => openConfirm({
                userId: id, title: `Delete all ${target.label.toLowerCase()} of ${name}?`, description: `${target.consequence} This cannot be undone.`, action: 'Delete all', destructive: true,
                run: (password, generation) => clear.mutate({ userId: id, generation, module: target.module, password }) })}>Delete all</Button>
            </SettingsRow>
          ))}
        </SettingsSection>
      </>
    );

  return (
    <PageShell panel={<SettingsPanel active="admin-users" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope={person ? `Users · ${name}` : 'Users'}
        back={<Button variant="ghost" size="icon" aria-label="Back to users" asChild><Link to="/admin/users"><ChevronLeft aria-hidden="true" /></Link></Button>} />
      <PageBody width="reading">{body}</PageBody>
      <PasswordConfirmDialog open={!!confirm && confirm.userId === id} onClose={() => setConfirm(null)} title={confirm?.title ?? ''} description={confirm?.description ?? ''} target={target}
        actionLabel={confirm?.action ?? ''} destructive={confirm?.destructive} pending={pending} onConfirm={password => { if (confirm?.userId === id) confirm.run(password, confirm.generation); }} />
      <AdminMailAccountDialog open={mailDialog.open} account={mailDialog.account} onClose={() => setMailDialog(CLOSED)} pending={saveMail.isPending} target={target}
        onSubmit={(fields, password) => saveMail.mutate({ userId: id, generation: mailDialog.generation, account: mailDialog.account, fields, password })} />
      <AdminCalendarAccountDialog open={calendarDialog.open} account={calendarDialog.account} onClose={() => setCalendarDialog(CLOSED)} pending={saveCalendar.isPending} target={target}
        onSubmit={(fields, password) => saveCalendar.mutate({ userId: id, generation: calendarDialog.generation, account: calendarDialog.account, fields, password })} />
    </PageShell>
  );
};

export default AdminUserDetail;
