import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { useSessionScope } from '@/lib/session-scope';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Loader2, LockKeyhole, MoreHorizontal, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useToast } from '@/hooks/use-toast';
import { hasCode } from '@/lib/api-error';
import {
  AdminHostTrustError, addAdminCalendarAccount, addAdminMailAccount, adminUserQueryKeys, clearAdminUserModule, deleteAdminUserBackup, deleteAdminUserBinItem, emptyAdminUserBin,
  fetchAdminUserAccounts, fetchAdminUserBackups, fetchAdminUserBin, removeAdminCalendarAccount, removeAdminMailAccount, updateAdminCalendarAccount, updateAdminMailAccount,
  type AdminCalendarAccount, type AdminClearModule, type AdminMailAccount,
} from '@/lib/admin-api';
import { BIN_MODULES, groupBinItems, type BinItem, type BinModule } from '@/lib/bin-api';
import type { MailHostTrustResult } from '@/components/mail/mail-page-model';
import { HostTrustDetails } from '@/components/mail/MailAccountDialog';
import type { BackupJob } from '@/lib/backup-api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import { usePersonActions } from '@/components/admin/PersonActions';
import { PersonAccount, PersonDevices, PersonGroups, PersonProfile } from '@/components/admin/PersonOrganisation';
import { usePeople } from '@/hooks/use-organisation';
import { can } from '@/lib/permissions';
import { AdminCalendarAccountDialog, AdminMailAccountDialog } from '@/components/admin/AdminAccountDialogs';

// The person's own list labels sections from the server's capabilities; here the ids and status words are shown as written, in sentence case.
const sentenceCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Server › People › a person: who they are here (role, groups, devices, the
// account itself; 0.30), then their mail and calendar accounts, backups, bin
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
  { module: 'contacts', label: 'Contacts', consequence: 'Every contact in their list is deleted. Contacts in their bin stay until the bin is emptied, here under Bin.' },
  { module: 'calendar', label: 'Calendar and ToDo', consequence: 'Every event and task of this person is deleted, with their calendars and calendar accounts. Events and tasks in their bin stay until the bin is emptied, here under Bin.' },
  { module: 'mail-accounts', label: 'Mail accounts', consequence: 'Every mail account of this person and its mail in UniHub is deleted. Mail at the providers is not touched.' },
  { module: 'recordings', label: 'Recordings', consequence: 'Every recording in their library is deleted. Recordings in their bin stay until the bin is emptied, here under Bin.' },
];

type Confirm = { userId: string; generation: number; title: string; description: string; action: string; destructive?: boolean; run: (password: string, generation: number) => void };
type For<T> = T & { userId: string; password: string; generation: number };
type AccountDialog<A> = { open: boolean; account: A | null; generation: number };
const CLOSED = { open: false, account: null, generation: 0 };
/** A mail server the administrator may trust: the fields of the refused request, to send again with the fingerprints. */
type HostTrustAsk = { userId: string; generation: number; account: AdminMailAccount | null; fields: Parameters<typeof updateAdminMailAccount>[2]; trust: MailHostTrustResult };
const BIN_KINDS: Record<BinItem['item_type'], string> = { contact: 'contact', event: 'event', task: 'task', recording: 'recording', calendar: 'calendar' };

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
  const navigate = useNavigate();
  const client = useQueryClient();
  const scope = useSessionScope();
  // The sections follow the permissions the server gave: reading people shows the page, managing them its changes.
  const admin = can(user, 'users.read');
  const manage = can(user, 'users.manage');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [mailDialog, setMailDialog] = useState<AccountDialog<AdminMailAccount>>(CLOSED);
  const [calendarDialog, setCalendarDialog] = useState<AccountDialog<AdminCalendarAccount>>(CLOSED);
  const [hostTrust, setHostTrust] = useState<HostTrustAsk | null>(null);
  const generations = useRef(0);
  const openConfirm = (spec: Omit<Confirm, 'generation'>) => setConfirm({ ...spec, generation: ++generations.current });
  const openMailDialog = (account: AdminMailAccount | null) => setMailDialog({ open: true, account, generation: ++generations.current });
  const openCalendarDialog = (account: AdminCalendarAccount | null) => setCalendarDialog({ open: true, account, generation: ++generations.current });
  const closeConfirm = (generation: number) => setConfirm(current => (current?.generation === generation ? null : current));
  const closeMailDialog = (generation: number) => setMailDialog(current => (current.generation === generation ? CLOSED : current));
  const closeCalendarDialog = (generation: number) => setCalendarDialog(current => (current.generation === generation ? CLOSED : current));

  const usersQuery = usePeople();
  const person = usersQuery.data?.find(entry => entry.id === id) ?? null;
  const actions = usePersonActions({ people: usersQuery.data, onDeleted: () => navigate('/admin/users', { replace: true }) });
  const accountsQuery = useQuery({ queryKey: adminUserQueryKeys.accounts(id), queryFn: ({ signal }) => fetchAdminUserAccounts(id, signal), enabled: manage && !!id });
  const backupsQuery = useQuery({ queryKey: adminUserQueryKeys.backups(id), queryFn: ({ signal }) => fetchAdminUserBackups(id, signal), enabled: manage && !!id });
  // The bin a page at a time, as the person's own (whole groups, newest first); "Show older items" appends the next page.
  const binQuery = useInfiniteQuery({
    queryKey: adminUserQueryKeys.bin(id), queryFn: ({ pageParam, signal }) => fetchAdminUserBin(id, pageParam, signal),
    initialPageParam: null as string | null, getNextPageParam: page => page.next_cursor, enabled: manage && !!id,
  });
  // A cursor the server no longer accepts (400 BIN_INVALID): the bin is read again from the newest items, with the server's word.
  const invalidCursor = hasCode(binQuery.error, 'BIN_INVALID') ? binQuery.error : null;
  useEffect(() => {
    if (!invalidCursor) return;
    toast({ title: 'Could not load older items', description: invalidCursor.message, variant: 'destructive' });
    void client.resetQueries({ queryKey: adminUserQueryKeys.bin(id), exact: true });
  }, [invalidCursor, client, id, toast]);
  const refreshAccounts = (userId: string) => { void client.invalidateQueries({ queryKey: adminUserQueryKeys.accounts(userId) }); };
  const refreshBackups = (userId: string) => { void client.invalidateQueries({ queryKey: adminUserQueryKeys.backups(userId) }); };
  const refreshBin = (userId: string) => { void client.invalidateQueries({ queryKey: adminUserQueryKeys.bin(userId) }); };
  const done = (title: string, generation: number, refresh: () => void) => { refresh(); closeConfirm(generation); toast({ title }); };
  // The server knows no such person (400 INVALID_USER_ID, 404 USER_NOT_FOUND): deleted meanwhile, or a stale link. Back to the list.
  const personGone = (error: unknown) => hasCode(error, 'USER_NOT_FOUND') || hasCode(error, 'INVALID_USER_ID');
  const GONE = { title: 'This person no longer exists', description: 'The account was deleted or never existed.' };
  const failed = (title: string) => (error: Error) => {
    if (personGone(error)) { toast(GONE); navigate('/admin/users', { replace: true }); return; }
    toast({ title, description: error.message, variant: 'destructive' });
  };
  const goneError = [accountsQuery.error, backupsQuery.error, binQuery.error].find(personGone);
  useEffect(() => {
    if (!goneError) return;
    toast({ title: 'This person no longer exists', description: 'The account was deleted or never existed.' });
    navigate('/admin/users', { replace: true });
  }, [goneError, toast, navigate]);
  // Another person's page: nothing opened for the previous one may stay.
  useEffect(() => { setConfirm(null); setMailDialog(CLOSED); setCalendarDialog(CLOSED); setHostTrust(null); }, [id]);

  const saveMail = useSecretMutation({
    mutationFn: ({ userId, account, fields, password }: For<{ account: AdminMailAccount | null; fields: Parameters<typeof updateAdminMailAccount>[2] }>) =>
      account ? updateAdminMailAccount(userId, account.id, fields, password) : addAdminMailAccount(userId, fields as Parameters<typeof addAdminMailAccount>[1], password),
    onSuccess: (_result, { userId, account, generation }) => { refreshAccounts(userId); closeMailDialog(generation); closeHostTrust(generation); toast({ title: account ? 'Mail account changed' : 'Mail account added' }); },
    onError: (error: Error, { userId, account, fields, generation }) => {
      // The mail server could not be verified: the administrator reviews its certificates and may trust them, with their password again.
      if (error instanceof AdminHostTrustError && userId === id) { setHostTrust({ userId, generation, account, fields, trust: error.trust }); return; }
      failed('Could not save the mail account')(error);
    },
  });
  const closeHostTrust = (generation: number) => setHostTrust(current => (current?.generation === generation ? null : current));
  const trustAndSave = (ask: HostTrustAsk, password: string) => saveMail.mutate({
    userId: ask.userId, generation: ask.generation, account: ask.account, password,
    fields: { ...ask.fields, accept_host_trust: true, trusted_imap_fingerprint256: ask.trust.certificates.imap?.fingerprint256 ?? undefined, trusted_smtp_fingerprint256: ask.trust.certificates.smtp?.fingerprint256 ?? undefined },
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
    onSuccess: (deleted, { userId, generation }) => done(deleted === 0 ? 'The bin was already empty' : `${deleted} ${deleted === 1 ? 'item' : 'items'} deleted for good`, generation, () => refreshBin(userId)),
    onError: failed('Could not empty the bin'),
  });
  // A bin group (a calendar with its events, a merge) is deleted member by
  // member through the one-item route, with the one confirmed password. The
  // count says how far it got when a member is refused, so the notice can say
  // what was deleted and what remains; one group delete runs at a time.
  const groupDeleted = useRef(0);
  const removeBinItem = useSecretMutation({
    mutationFn: async ({ userId, itemIds, password }: For<{ itemIds: string[] }>) => {
      groupDeleted.current = 0;
      for (const itemId of itemIds) {
        // Every member is sent in the session the administrator confirmed in. The hook's callbacks
        // stop when that session ends (a sign-out, another account); a running mutationFn does not,
        // so it checks after each answer, before the next request, and sends nothing under a later
        // session. What went before stays deleted; the next session's bin shows what remains.
        if (scope.ended) throw new Error('The session ended before every item was deleted.');
        await deleteAdminUserBinItem(userId, itemId, password);
        groupDeleted.current += 1;
      }
      return itemIds.length;
    },
    onSuccess: (count, { userId, generation }) => done(count > 1 ? `${count} items deleted for good` : 'Deleted for good', generation, () => refreshBin(userId)),
    // The shared handler's "Nothing was changed" does not hold once members went: it says this instead.
    partly: ({ itemIds }) => groupDeleted.current ? `${groupDeleted.current} of ${itemIds.length} items were deleted for good before; ${plural(itemIds.length - groupDeleted.current, 'item')} ${itemIds.length - groupDeleted.current === 1 ? 'remains' : 'remain'} in the bin.` : null,
    onError: (error: Error, { userId, itemIds, generation }) => {
      const deleted = groupDeleted.current;
      if (deleted === 0) { failed('Could not delete the item')(error); return; }
      // Part of the group is gone: the row is read again (what remains is one smaller group), the confirmation is over.
      refreshBin(userId);
      closeConfirm(generation);
      const remaining = itemIds.length - deleted;
      toast({ title: `${deleted} of ${itemIds.length} items deleted for good`, description: `${plural(remaining, 'item')} ${remaining === 1 ? 'remains' : 'remain'} in the bin. ${error.message}`, variant: 'destructive', duration: 10000 });
    },
  });
  const clear = useSecretMutation({
    mutationFn: ({ userId, module, password }: For<{ module: AdminClearModule }>) => clearAdminUserModule(userId, module, password),
    onSuccess: (_result, { userId, module, generation }) => done(`${CLEAR_TARGETS.find(target => target.module === module)?.label} deleted`, generation, () => { refreshAccounts(userId); refreshBackups(userId); }),
    onError: failed('Could not delete the data'),
  });
  const pending = removeMail.isPending || removeCalendar.isPending || removeBackup.isPending || emptyBin.isPending || removeBinItem.isPending || clear.isPending;

  const name = person?.full_name || person?.email || 'this person';
  // Every dialog names the person it acts for, with the address so that two people of one name stay apart.
  const target = person ? (person.full_name ? `${person.full_name} (${person.email})` : person.email) : name;
  const binItems = binQuery.data?.pages.flatMap(page => page.items) ?? [];
  const olderItems = binQuery.hasNextPage;
  const binCount = (module: BinModule) => binItems.filter(item => item.module === module).length;
  const nothingAtAll = accountsQuery.data && backupsQuery.data && binQuery.data && accountsQuery.data.mail_accounts.length === 0 && accountsQuery.data.calendar_accounts.length === 0 && backupsQuery.data.length === 0 && binItems.length === 0;
  const body = !admin ? <p className="text-sm text-muted-foreground">Only administrators can see this page.</p>
    : usersQuery.isLoading ? <LoadingState label="Loading the account…" />
    : usersQuery.error ? <ErrorState title="Could not load the account" error={usersQuery.error} onRetry={() => void usersQuery.refetch()} retrying={usersQuery.isFetching} />
    : !person ? <ErrorState title="No such account" error="The account may have been deleted." />
    : (
      <>
        <PersonProfile person={person} actions={actions} />
        <PersonGroups person={person} />
        <PersonDevices person={person} />
        <PersonAccount person={person} actions={actions} />
        {manage && <>
        <p className="mb-8 max-w-prose text-sm text-muted-foreground">
          What you do below is done for {name} as if they did it, with your password, and recorded in the activity log. A rule that forbids them an action does not apply to you.
        </p>
        {nothingAtAll && (
          <p role="status" className="mb-8 max-w-prose text-sm text-muted-foreground">{name} has no mail or calendar accounts, no backups on this server and nothing in their bin yet. Their data can still be deleted below.</p>
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
              <SettingsRow key={job.id} label={<span className="flex items-center gap-1.5">{job.encryption_enabled && <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />}{job.scope === 'full' ? 'Full backup' : `${job.requested_sections.map(sentenceCase).join(', ')} backup`}</span>}
                description={[sentenceCase(job.status), formatWhen(job.completed_at || job.created_at), job.file_size ? formatBytes(job.file_size) : null, ].filter(Boolean).join(' · ')}>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={['queued', 'running', 'cancelling'].includes(job.status)} onClick={() => openConfirm({
                  userId: id, title: `Delete this backup of ${name}?`, description: 'The archive is removed from the server, whatever the minimum your rule keeps it for. A copy they downloaded is not affected.', action: 'Delete backup', destructive: true,
                  run: (password, generation) => removeBackup.mutate({ userId: id, generation, jobId: job.id, password }) })}>Delete</Button>
              </SettingsRow>
            ))}
        </SettingsSection>

        <SettingsSection title="Bin" description={`What ${name} deleted waits in their bin until it is restored or gone for good. Deleting here is allowed whatever the bin rule says for them.`}
          action={<Button size="sm" variant="outline" className="text-destructive hover:text-destructive" disabled={binItems.length === 0} onClick={() => openConfirm({
            userId: id, title: `Empty the bin of ${name}?`, description: olderItems ? 'Everything in it, also the older items not shown yet, is deleted for good and cannot be restored.' : `${plural(binItems.length, 'item')} ${binItems.length === 1 ? 'is' : 'are'} deleted for good and cannot be restored.`, action: 'Delete for good', destructive: true,
            run: (password, generation) => emptyBin.mutate({ userId: id, generation, password }) })}>Empty bin</Button>}>
          {binQuery.isLoading ? <SettingsBlock><LoadingState compact label="Loading the bin…" /></SettingsBlock>
            : binQuery.error && !binQuery.isFetchNextPageError ? <SettingsBlock><ErrorState title="Could not load the bin" error={binQuery.error} onRetry={() => void binQuery.refetch()} retrying={binQuery.isFetching} /></SettingsBlock>
            : binItems.length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">The bin of {name} is empty.</p></SettingsBlock>
            : <>
              {BIN_MODULES.filter(module => binCount(module.id) > 0).map(module => (
                <SettingsRow key={module.id} label={module.label} description={`${plural(binCount(module.id), 'item')}${olderItems ? ' shown' : ''}`}>
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => openConfirm({
                    userId: id, title: `Empty the ${module.label.toLowerCase()} bin of ${name}?`, description: 'Everything in it is deleted for good and cannot be restored.', action: 'Delete for good', destructive: true,
                    run: (password, generation) => emptyBin.mutate({ userId: id, generation, module: module.id, password }) })}>Empty</Button>
                </SettingsRow>
              ))}
              {groupBinItems(binItems).map(group => {
                const lead = group[0];
                const title = lead.title || `Untitled ${BIN_KINDS[lead.item_type]}`;
                return (
                  <SettingsRow key={lead.group_id ?? lead.id} label={<>{title}<span className="font-normal text-muted-foreground"> · {BIN_MODULES.find(module => module.id === lead.module)?.label ?? lead.module}</span></>}
                    description={[`Deleted ${formatWhen(lead.deleted_at)}`, lead.purge_after ? `gone for good ${formatWhen(lead.purge_after)}` : 'kept until restored or deleted', group.length > 1 ? `with ${group.length - 1} ${group.length === 2 ? 'item' : 'items'}` : null].filter(Boolean).join(' · ')}>
                    <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" aria-label={`Delete ${title} for good`} onClick={() => openConfirm({
                      userId: id, title: `Delete ${title} for good?`, description: group.length > 1 ? `${group.length} items of ${name} are deleted for good and cannot be restored.` : `It is deleted from the bin of ${name} for good and cannot be restored.`, action: 'Delete for good', destructive: true,
                      run: (password, generation) => removeBinItem.mutate({ userId: id, generation, itemIds: group.map(item => item.id), password }) })}>Delete for good</Button>
                  </SettingsRow>
                );
              })}
              {binQuery.isFetchNextPageError && !invalidCursor && (
                <SettingsRow label={<span role="alert" className="text-destructive">Could not load older items</span>} description={binQuery.error?.message}>
                  <Button variant="outline" size="sm" onClick={() => void binQuery.fetchNextPage({ cancelRefetch: false })} disabled={binQuery.isFetching}>Try again</Button>
                </SettingsRow>
              )}
              {olderItems && !binQuery.isFetchNextPageError && (
                <SettingsRow label="Older items" description="The bin holds more than is shown.">
                  {/* Waits while the bin is being read again after a change: a next page must not cancel that refresh and extend the stale pages. */}
                  <Button variant="outline" size="sm" onClick={() => void binQuery.fetchNextPage({ cancelRefetch: false })} disabled={binQuery.isFetching}>
                    {binQuery.isFetchingNextPage && <Loader2 aria-hidden="true" className="animate-spin" />}Show older items
                  </Button>
                </SettingsRow>
              )}
            </>}
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
        </>}
      </>
    );

  return (
    <PageShell panel={<SettingsPanel active="admin-users" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope={person ? `People · ${name}` : 'People'}
        back={<Button variant="ghost" size="icon" aria-label="Back to people" asChild><Link to="/admin/users"><ChevronLeft aria-hidden="true" /></Link></Button>} />
      <PageBody width="reading">{body}</PageBody>
      {actions.dialogs}
      <PasswordConfirmDialog open={!!confirm && confirm.userId === id} onClose={() => setConfirm(null)} title={confirm?.title ?? ''} description={confirm?.description ?? ''} target={target}
        actionLabel={confirm?.action ?? ''} destructive={confirm?.destructive} pending={pending} onConfirm={password => { if (confirm?.userId === id) confirm.run(password, confirm.generation); }} />
      <AdminMailAccountDialog open={mailDialog.open} account={mailDialog.account} onClose={() => setMailDialog(CLOSED)} pending={saveMail.isPending} target={target}
        onSubmit={(fields, password) => saveMail.mutate({ userId: id, generation: mailDialog.generation, account: mailDialog.account, fields, password })} />
      <AdminCalendarAccountDialog open={calendarDialog.open} account={calendarDialog.account} onClose={() => setCalendarDialog(CLOSED)} pending={saveCalendar.isPending} target={target}
        onSubmit={(fields, password) => saveCalendar.mutate({ userId: id, generation: calendarDialog.generation, account: calendarDialog.account, fields, password })} />
      <PasswordConfirmDialog open={!!hostTrust && hostTrust.userId === id} onClose={() => { if (!saveMail.isPending) setHostTrust(null); }} title="Trust this mail server?"
        description="The server's certificate could not be verified. Compare the fingerprints with the ones on the mail server before the account trusts them." target={target}
        actionLabel="Trust and save" pending={saveMail.isPending} onConfirm={password => { if (hostTrust?.userId === id) trustAndSave(hostTrust, password); }}>
        {hostTrust && <div className="max-h-[40dvh] space-y-3 overflow-y-auto"><HostTrustDetails trust={hostTrust.trust} /></div>}
      </PasswordConfirmDialog>
    </PageShell>
  );
};

export default AdminUserDetail;
