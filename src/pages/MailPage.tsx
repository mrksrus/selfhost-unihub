import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { PenSquare, Plus } from 'lucide-react';
import { captureMailFlagReconciler, fetchMailThread, mailQueryKeys, type Email } from '@/lib/mail-api';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import { snoozeChoices } from '@/lib/mail-times';
import type { TaskSource } from '@/lib/email-tasks';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useUserTimezone } from '@/contexts/useAuth';
import { NARROW_QUERY, useIsMobile, useMediaQuery } from '@/hooks/use-mobile';
import { useMailAccounts } from '@/hooks/use-mail-queries';
import { useMailAccountSelection, useRememberedMailAccount } from '@/hooks/use-mail-account-selection';
import { useMailFolderView } from '@/hooks/use-mail-folder-view';
import { useMailListView } from '@/hooks/use-mail-list-view';
import { useMailListSelection, useMailListShortcuts } from '@/hooks/use-mail-list-selection';
import { useMailBulkActions } from '@/hooks/use-mail-bulk-actions';
import { useMailReader, useMailReaderRefresh } from '@/hooks/use-mail-reader';
import { useMailFlags } from '@/hooks/use-mail-flags';
import { useMailCompose } from '@/hooks/use-mail-compose';
import { useMailAccountEditor } from '@/hooks/use-mail-account-editor';
import { useMailAccountRemoval } from '@/hooks/use-mail-account-removal';
import { useMailSyncJobs } from '@/hooks/use-mail-sync-jobs';
import { useMailWritebacks } from '@/hooks/use-mail-writebacks';
import { useMailSnooze } from '@/hooks/use-mail-snooze';
import { useMailSchedule } from '@/hooks/use-mail-schedule';
import { useOfflineReadOnly } from '@/hooks/use-offline-read-only';
import { MailAccountList, MailPanel } from '@/components/mail/MailPanel';
import { PageShell } from '@/components/layout/PageShell';
import MailFolderNavigation from '@/components/mail/MailFolderNavigation';
import { MailLegacyRecovery, MailListToolbar } from '@/components/mail/MailListToolbar';
import { MailContextMenu, MailMessageList } from '@/components/mail/MailMessageList';
import { EmailTaskDialog } from '@/components/mail/EmailTaskDialog';
import { MailReader, MailReaderLoading } from '@/components/mail/MailReader';
import { MailComposeDialog, MailComposeDialogs, MailInlineCompose } from '@/components/mail/MailCompose';
import { MailAccountDialog } from '@/components/mail/MailAccountDialog';
import { MailAccountRemovalDialogs } from '@/components/mail/MailAccountRemovalDialogs';
import { MailFolderDialogs } from '@/components/mail/MailFolderDialogs';
import { MailSyncControl, type SyncPanelFocus } from '@/components/mail/MailSyncControl';
import { WhenDialog } from '@/components/mail/WhenPicker';
import { systemFolders, ALL_ACCOUNTS, LEGACY_ACCOUNT, ALL_MAIL, SNOOZED } from '@/components/mail/mail-page-model';

/**
 * Mail: account/folder sidebar, message list and reader (side by side on wide
 * screens). This page wires the mail hooks to the mail components; behavior
 * lives in src/hooks/use-mail-* and src/components/mail/.
 */
const MailPage = () => {
  const { toast } = useToast();
  const timezone = useUserTimezone();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const narrow = useMediaQuery(NARROW_QUERY);
  const { accountId: activeMailAccountId, queryAccount: selectedAccount, selectAccount: setSelectedAccount } = useMailAccountSelection();
  const { data: accounts = [], isLoading: accountsLoading } = useMailAccounts();
  const folderView = useMailFolderView(selectedAccount, accounts);
  const { selectedFolder, setSelectedFolder, folders, movableFolderIds } = folderView;
  useRememberedMailAccount(accounts, selectedAccount, setSelectedAccount, setSelectedFolder);
  // Legacy is hidden once empty, so do not stay in it (remembered, or after recovering the last message).
  useEffect(() => {
    if (selectedAccount === LEGACY_ACCOUNT && folderView.foldersLoaded && folderView.legacyCount === 0) {
      setSelectedAccount(ALL_ACCOUNTS);
      setSelectedFolder('inbox');
    }
  }, [selectedAccount, folderView.foldersLoaded, folderView.legacyCount, setSelectedAccount, setSelectedFolder]);

  const { selectedEmail, setSelectedEmail, isReaderLoading, closeReader, loadEmail } = useMailReader(selectedAccount);
  const { flagRequests, requestFlag } = useMailFlags(setSelectedEmail, (kind, message, unknown) => {
    toast({ title: unknown ? 'No answer from UniHub yet' : kind === 'read' ? 'Failed to update read status' : 'Failed to update star', description: message, variant: 'destructive' });
  });
  const { refreshSettledEmail, supersedeRefresh } = useMailReaderRefresh(selectedEmail?.id, setSelectedEmail);
  const accountEditor = useMailAccountEditor();
  const compose = useMailCompose({ activeMailAccountId, selectedAccount, isMobile });
  const accountRemoval = useMailAccountRemoval(() => setSelectedAccount(ALL_ACCOUNTS));
  const [contextMenuEmail, setContextMenuEmail] = useState<{ email: Email; x: number; y: number } | null>(null);
  const [taskEmail, setTaskEmail] = useState<TaskSource | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const { jobs: syncJobs, requestSync, syncingAccountIds, requestCancel, cancellingAccountIds } = useMailSyncJobs(accounts);
  const writebacks = useMailWritebacks(refreshSettledEmail);
  const [syncPanel, setSyncPanel] = useState<SyncPanelFocus | null>(null);
  // Offline is read-only: snooze and scheduled-send actions wait for a connection.
  const readOnly = useOfflineReadOnly();
  const snoozeTimes = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('snooze_choices') }).data ?? [];
  const threadedView = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('mail_threaded_view') }).data ?? false;
  const snooze = useMailSnooze({ onSnoozedAway: id => { if (selectedEmail?.id === id && !compose.isReplying) closeReader(); } });
  const schedule = useMailSchedule();
  // The message whose snooze time is being picked (row menu).
  const [snoozeTarget, setSnoozeTarget] = useState<Email | null>(null);

  const list = useMailListView(selectedAccount, selectedFolder);
  const { emails } = list;
  const selection = useMailListSelection(`${selectedAccount ?? ''}\n${selectedFolder}`, emails);
  const { selectedIds } = selection;
  const bulk = useMailBulkActions({ emails, selectedEmail, selectedFolder, requestFlag, clearSelection: selection.clearSelection,
    // The open message left this folder: close it, unless a reply is being written.
    onMovedAway: ids => { if (selectedEmail && ids.includes(selectedEmail.id) && !compose.isReplying) closeReader(); } });
  useMailListShortcuts(selection, emails, bulk.trash);

  // The list rows open the reader at once; a link without a row waits for the load.
  const rows = useRef(emails);
  rows.current = emails;
  const openDraft = compose.openDraftForCompose;
  const loadEmailForReader = React.useCallback((emailId: string) => {
    supersedeRefresh();
    const row = rows.current.find(email => email.id === emailId);
    return loadEmail(emailId, {
      // The detail does not carry a draft's schedule; the list row does.
      onDraft: draft => openDraft({ ...draft, scheduled_send_at: row?.scheduled_send_at ?? null, scheduled_send_status: row?.scheduled_send_status ?? null }),
      reconcileEmail: captureMailFlagReconciler(queryClient),
      onMarkRead: (email) => requestFlag(email, 'read', true),
      onUndoMarkRead: (email) => requestFlag({ ...email, is_read: true }, 'read', false),
      onError: (message) => toast({ title: 'Failed to load email', description: message, variant: 'destructive' }),
    }, row);
  }, [loadEmail, supersedeRefresh, openDraft, requestFlag, queryClient, toast]);

  // The conversation around the open message (threaded view). Keyed by the
  // message, so another message never shows this one's conversation.
  const thread = useQuery({
    queryKey: mailQueryKeys.thread(selectedEmail?.id ?? ''),
    queryFn: ({ signal }) => fetchMailThread(selectedEmail!.id, signal),
    enabled: threadedView && !!selectedEmail && !isReaderLoading,
    staleTime: 60000,
  });

  // Open a message linked from a notification or search, then drop the parameter.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const emailId = params.get('email');
    if (!emailId) return;

    void loadEmailForReader(emailId);
    params.delete('email');
    navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, { replace: true });
  }, [loadEmailForReader, location.pathname, location.search, location.hash, navigate]);

  // The attention tray links here to review mail decisions in the sync panel.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const review = params.get('review');
    if (!review) return;
    setSyncPanel(review === 'attention' || review === 'decision' ? review : 'default');
    params.delete('review');
    navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, { replace: true });
  }, [location.pathname, location.search, location.hash, navigate]);

  // A task from the draft being written: the draft is saved first so the task can lead back to it.
  const addTaskFromDraft = async () => {
    let draft: Email | null = null;
    try { draft = await compose.saveCurrentDraft({ includeAttachments: true, quiet: true }); }
    catch (error) { toast({ title: 'Could not save the draft', description: error instanceof Error ? error.message : undefined, variant: 'destructive' }); return; }
    const id = draft?.id ?? compose.activeDraftId;
    if (!id) { toast({ title: 'Write something first', description: 'The draft is saved so the task can lead back to it.' }); return; }
    const account = accounts.find(entry => entry.id === compose.fromAccountId);
    setTaskEmail({ id, is_draft: true, subject: compose.composeForm.subject, from_name: account?.display_name ?? null, from_address: account?.email_address ?? '',
      received_at: new Date().toISOString(), attachments: draft?.attachments ?? compose.existingDraftAttachments });
  };

  const selectedAccountData = accounts.find(a => a.id === selectedAccount);
  const selectedFolderData = folders.find((folder) => folder.id === selectedFolder);
  const folderLabel = selectedFolder === ALL_MAIL ? 'All mail' : selectedFolder === SNOOZED ? 'Snoozed' : selectedFolderData?.label || selectedFolder;
  const accountLabel = selectedAccount === LEGACY_ACCOUNT ? 'Legacy — needs review' : selectedAccount === ALL_ACCOUNTS
    ? 'All accounts'
    : selectedAccountData?.display_name || selectedAccountData?.email_address || 'No account selected';
  const movableFolders = folders.filter(folder => movableFolderIds.includes(folder.id));
  const senderAlreadyInContacts = selectedEmail
    ? compose.contactEmailSuggestions.some((suggestion) => suggestion.email.toLowerCase() === selectedEmail.from_address.toLowerCase())
    : false;

  const panel = (
    <MailPanel onCompose={compose.openCompose}>
      <MailAccountList accounts={accounts} loading={accountsLoading} selectedAccount={selectedAccount} legacyCount={folderView.legacyCount}
        addAccount={<MailAccountDialog editor={accountEditor} touch={isMobile} trigger={
          <Button variant="ghost" size="icon-xs" aria-label="Add mail account" title="Add mail account">
            <Plus aria-hidden="true" />
          </Button>
        } />}
        onSelect={id => {
          setSelectedAccount(id);
          if (id === LEGACY_ACCOUNT) setSelectedFolder(ALL_MAIL);
        }}
        onEdit={accountEditor.startEdit}
        onRemove={account => {
          if (account.disconnected_at) void accountRemoval.openPurgePreview(account.id);
          else accountRemoval.requestDisconnect(account.id);
        }} />
      <MailFolderNavigation
        folders={folderView.folderFilters}
        systemIds={systemFolders.map(folder => folder.id)}
        selectedFolder={selectedFolder}
        accountLabel={accountLabel}
        unreadByFolder={folderView.unreadByFolder}
        onSelect={setSelectedFolder}
        onManage={() => setFolderDialogOpen(true)}
      />
    </MailPanel>
  );

  return (
    <PageShell panel={panel} panelLabel="Accounts and folders" panelId="mail">
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <MailListToolbar emailCount={emails.length}
          selection={selection} folderLabel={folderLabel} accountLabel={accountLabel} account={selectedAccount} list={list}
          bulk={bulk} moveTargets={movableFolders.filter(folder => folder.id !== selectedFolder)} onCompose={compose.openCompose}
          syncControl={
            <MailSyncControl accounts={accounts}
              viewAccountIds={activeMailAccountId ? [activeMailAccountId] : accounts.filter(account => account.is_active).map(account => account.id)}
              jobs={syncJobs.data ?? []} jobsError={syncJobs.isError} operations={writebacks.data ?? []} operationsError={writebacks.isError}
              syncing={syncingAccountIds} cancelling={cancellingAccountIds} onSync={requestSync} onCancel={requestCancel}
              panel={syncPanel} onPanelChange={setSyncPanel} touch={isMobile} />
          } />
        {selectedAccount === LEGACY_ACCOUNT && (
          <MailLegacyRecovery accounts={accounts} folders={folderView.mailFolders} selectedIds={selectedIds}
            onRecover={(accountId, folder) => bulk.move(selectedIds, folder, accountId)} />
        )}

        <MailMessageList account={selectedAccount} folder={selectedFolder} folderLabel={folderLabel} accountLabel={accountLabel}
          list={list} selection={selection} accounts={accounts} flagRequests={flagRequests} requestFlag={requestFlag}
          onOpen={loadEmailForReader} onContextMenu={(email, x, y) => setContextMenuEmail({ email, x, y })}
          onAddAccount={accountEditor.openAdd} snooze={snooze} schedule={schedule} readOnly={readOnly} />
      </div>

      {narrow && !selectedEmail && (
        <Button onClick={compose.openCompose} aria-label="Compose"
          className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] right-4 z-30 h-14 w-14 rounded-2xl shadow-lg md:bottom-6 md:right-6 [&_svg]:size-5">
          <PenSquare aria-hidden="true" />
        </Button>
      )}

      {isReaderLoading && !selectedEmail && <MailReaderLoading onCancel={closeReader} />}

      {contextMenuEmail && (
        <MailContextMenu target={contextMenuEmail} onClose={() => setContextMenuEmail(null)} requestFlag={requestFlag}
          movableFolders={movableFolders} bulk={bulk} onDeleteDraft={compose.setDraftToDelete} onAddTask={setTaskEmail}
          onSnooze={setSnoozeTarget} onUnsnooze={snooze.unsnooze} readOnly={readOnly} />
      )}
      <WhenDialog open={!!snoozeTarget} onOpenChange={open => { if (!open) setSnoozeTarget(null); }} title="Snooze until"
        description="The message leaves its list and comes back at this time, with a notification." choices={snoozeChoices(snoozeTimes)}
        confirmLabel="Snooze" onPick={at => { if (snoozeTarget) snooze.snooze(snoozeTarget, at); }} />
      <WhenDialog open={!!schedule.picking} onOpenChange={open => { if (!open) schedule.setPicking(null); }} title="Send later"
        description="The draft is sent at this time." initial={schedule.picking?.scheduled_send_status === 'scheduled' && schedule.picking.scheduled_send_at ? new Date(schedule.picking.scheduled_send_at) : null}
        confirmLabel="Schedule" onPick={at => { if (schedule.picking) void schedule.reschedule(schedule.picking, at); }} />
      <EmailTaskDialog email={taskEmail} onClose={() => setTaskEmail(null)} timezone={timezone}
        onCreated={task => setSelectedEmail(prev => prev && prev.id === task.source_email?.email_id ? { ...prev, tasks: [...(prev.tasks ?? []), task] } : prev)} />

      <MailAccountRemovalDialogs removal={accountRemoval} accounts={accounts} />

      {selectedEmail && (
        <MailReader email={selectedEmail} loading={isReaderLoading} accounts={accounts} location={`${accountLabel} / ${folderLabel}`}
          backLabel={`Back to ${accountLabel}, ${folderLabel}`} isMobile={isMobile} isReplying={compose.isReplying}
          flagRequests={flagRequests} requestFlag={requestFlag} senderInContacts={senderAlreadyInContacts}
          onBack={() => {
            if (compose.isReplying && compose.isDirty) {
              compose.closeComposeFlow();
              return;
            }
            closeReader();
            compose.resetComposeState();
          }}
          onReply={() => compose.startResponse(selectedEmail, 'reply')}
          onReplyAll={() => compose.startResponse(selectedEmail, 'replyAll')}
          onForward={() => compose.startResponse(selectedEmail, 'forward')}
          onAddTask={() => setTaskEmail(selectedEmail)} timezone={timezone}
          snooze={{ choices: snoozeChoices(snoozeTimes), onSnooze: at => snooze.snooze(selectedEmail, at), onUnsnooze: () => snooze.unsnooze(selectedEmail),
            pending: snooze.isPending(selectedEmail.id), readOnly }}
          thread={threadedView ? thread.data ?? null : null}
          inlineCompose={!isMobile && compose.isReplying && <MailInlineCompose compose={compose} onAddTask={addTaskFromDraft} />} />
      )}

      <MailFolderDialogs open={folderDialogOpen} onOpenChange={setFolderDialogOpen} activeMailAccountId={activeMailAccountId}
        folders={folderView.visibleMailFolders} accounts={accounts} selectedFolder={selectedFolder} onSelectFolder={setSelectedFolder} />

      <MailComposeDialogs compose={compose} />

      <MailComposeDialog compose={compose} accounts={accounts} isMobile={isMobile} onAddTask={addTaskFromDraft} />

    </div>
    </PageShell>
  );
};

export default MailPage;
