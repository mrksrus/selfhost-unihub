import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { captureMailFlagReconciler, type Email } from '@/lib/mail-api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useIsMobile } from '@/hooks/use-mobile';
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
import { MailAccountList, MailSidebar } from '@/components/mail/MailSidebar';
import MailFolderNavigation from '@/components/mail/MailFolderNavigation';
import { MailLegacyRecovery, MailListToolbar } from '@/components/mail/MailListToolbar';
import { MailContextMenu, MailMessageList } from '@/components/mail/MailMessageList';
import { MailReader, MailReaderLoading } from '@/components/mail/MailReader';
import { MailComposeDialog, MailComposeDialogs, MailInlineCompose } from '@/components/mail/MailCompose';
import { MailAccountDialog } from '@/components/mail/MailAccountDialog';
import { MailAccountRemovalDialogs } from '@/components/mail/MailAccountRemovalDialogs';
import { MailFolderDialogs } from '@/components/mail/MailFolderDialogs';
import { MailSyncAttentionLine, MailSyncControl, type SyncPanelFocus } from '@/components/mail/MailSyncControl';
import { systemFolders, ALL_ACCOUNTS, LEGACY_ACCOUNT, ALL_MAIL } from '@/components/mail/mail-page-model';

/**
 * Mail: account/folder sidebar, message list and reader (side by side on wide
 * screens). This page wires the mail hooks to the mail components; behavior
 * lives in src/hooks/use-mail-* and src/components/mail/.
 */
const MailPage = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
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
    toast({ title: unknown ? `${kind === 'read' ? 'Read' : 'Star'} request outcome unknown` : kind === 'read' ? 'Failed to update read status' : 'Failed to update star', description: message, variant: 'destructive' });
  });
  const { refreshSettledEmail, supersedeRefresh } = useMailReaderRefresh(selectedEmail?.id, setSelectedEmail);
  const accountEditor = useMailAccountEditor();
  const compose = useMailCompose({ activeMailAccountId, selectedAccount, setSelectedAccount, isMobile });
  const accountRemoval = useMailAccountRemoval(() => setSelectedAccount(ALL_ACCOUNTS));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [contextMenuEmail, setContextMenuEmail] = useState<{ email: Email; x: number; y: number } | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const { jobs: syncJobs, requestSync, syncingAccountIds, requestCancel, cancellingAccountIds } = useMailSyncJobs(accounts);
  const writebacks = useMailWritebacks(refreshSettledEmail);
  const [syncPanel, setSyncPanel] = useState<SyncPanelFocus | null>(null);

  const list = useMailListView(selectedAccount, selectedFolder);
  const { emails } = list;
  const selection = useMailListSelection(`${selectedAccount ?? ''}\n${selectedFolder}`, emails);
  const { selectedIds } = selection;
  const bulk = useMailBulkActions({ emails, selectedEmail, selectedFolder, requestFlag, clearSelection: selection.clearSelection });
  useMailListShortcuts(selection, emails, bulk.trash);

  const loadEmailForReader = React.useCallback((emailId: string) => {
    supersedeRefresh();
    return loadEmail(emailId, {
      onDraft: compose.openDraftForCompose,
      reconcileEmail: captureMailFlagReconciler(queryClient),
      onMarkRead: (email) => requestFlag(email, 'read', true),
      onError: (message) => toast({ title: 'Failed to load email', description: message, variant: 'destructive' }),
    });
  }, [loadEmail, supersedeRefresh, compose.openDraftForCompose, requestFlag, queryClient, toast]);

  // Open a message linked from a notification or search, then drop the parameter.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const emailId = params.get('email');
    if (!emailId) return;

    void loadEmailForReader(emailId);
    params.delete('email');
    navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, { replace: true });
  }, [loadEmailForReader, location.pathname, location.search, location.hash, navigate]);

  const selectedAccountData = accounts.find(a => a.id === selectedAccount);
  const selectedFolderData = folders.find((folder) => folder.id === selectedFolder);
  const folderLabel = selectedFolder === ALL_MAIL ? 'All mail' : selectedFolderData?.label || selectedFolder;
  const accountLabel = selectedAccount === LEGACY_ACCOUNT ? 'Legacy — needs review' : selectedAccount === ALL_ACCOUNTS
    ? 'All accounts'
    : selectedAccountData?.display_name || selectedAccountData?.email_address || 'No account selected';
  const movableFolders = folders.filter(folder => movableFolderIds.includes(folder.id));
  const senderAlreadyInContacts = selectedEmail
    ? compose.contactEmailSuggestions.some((suggestion) => suggestion.email.toLowerCase() === selectedEmail.from_address.toLowerCase())
    : false;

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <MailSidebar isMobile={isMobile} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
        mobileOpen={mobileSidebarOpen} onMobileOpenChange={setMobileSidebarOpen} onCompose={compose.openCompose}>
        <MailAccountList accounts={accounts} loading={accountsLoading} selectedAccount={selectedAccount} legacyCount={folderView.legacyCount}
          compact={sidebarCollapsed && !isMobile}
          addAccount={<MailAccountDialog editor={accountEditor} touch={isMobile} trigger={
            <Button variant="ghost" size="icon" className={`h-6 w-6 ${(sidebarCollapsed && !isMobile) ? 'mx-auto' : ''}`} title={(sidebarCollapsed && !isMobile) ? 'Add Account' : undefined}>
              <Plus className="h-4 w-4" />
            </Button>
          } />}
          onSelect={id => {
            setSelectedAccount(id);
            if (id === LEGACY_ACCOUNT) setSelectedFolder(ALL_MAIL);
            if (isMobile) setMobileSidebarOpen(false);
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
          collapsed={sidebarCollapsed && !isMobile}
          unreadByFolder={folderView.unreadByFolder}
          onSelect={id => { setSelectedFolder(id); if (isMobile) setMobileSidebarOpen(false); }}
          onManage={() => setFolderDialogOpen(true)}
        />
      </MailSidebar>

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <MailSyncAttentionLine operations={writebacks.data ?? []} accounts={accounts} onReview={setSyncPanel} />
        {selectedAccount === LEGACY_ACCOUNT && (
          <MailLegacyRecovery accounts={accounts} folders={folderView.mailFolders} selectedIds={selectedIds}
            onRecover={(accountId, folder) => bulk.move(selectedIds, folder, accountId)} />
        )}
        <MailListToolbar isMobile={isMobile} onOpenSidebar={() => setMobileSidebarOpen(true)} emailCount={emails.length}
          selection={selection} folderLabel={folderLabel} accountLabel={accountLabel} account={selectedAccount} list={list}
          bulk={bulk} moveTargets={movableFolders.filter(folder => folder.id !== selectedFolder)}
          syncControl={
            <MailSyncControl accounts={accounts}
              viewAccountIds={activeMailAccountId ? [activeMailAccountId] : accounts.filter(account => account.is_active).map(account => account.id)}
              jobs={syncJobs.data ?? []} jobsError={syncJobs.isError} operations={writebacks.data ?? []} operationsError={writebacks.isError}
              syncing={syncingAccountIds} cancelling={cancellingAccountIds} onSync={requestSync} onCancel={requestCancel}
              panel={syncPanel} onPanelChange={setSyncPanel} touch={isMobile} />
          } />

        <MailMessageList account={selectedAccount} folder={selectedFolder} folderLabel={folderLabel} accountLabel={accountLabel}
          list={list} selection={selection} accounts={accounts} flagRequests={flagRequests} requestFlag={requestFlag}
          onOpen={loadEmailForReader} onContextMenu={(email, x, y) => setContextMenuEmail({ email, x, y })}
          onAddAccount={accountEditor.openAdd} />
      </div>

      {isReaderLoading && <MailReaderLoading onCancel={closeReader} />}

      {contextMenuEmail && (
        <MailContextMenu target={contextMenuEmail} onClose={() => setContextMenuEmail(null)} requestFlag={requestFlag}
          movableFolders={movableFolders} bulk={bulk} onDeleteDraft={compose.setDraftToDelete} />
      )}

      <MailAccountRemovalDialogs removal={accountRemoval} accounts={accounts} />

      {selectedEmail && (
        <MailReader email={selectedEmail} accounts={accounts} location={`${accountLabel} / ${folderLabel}`}
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
          onForward={() => compose.startResponse(selectedEmail, 'forward')}
          inlineCompose={!isMobile && compose.isReplying && <MailInlineCompose compose={compose} />} />
      )}

      <MailFolderDialogs open={folderDialogOpen} onOpenChange={setFolderDialogOpen} activeMailAccountId={activeMailAccountId}
        folders={folderView.visibleMailFolders} accounts={accounts} selectedFolder={selectedFolder} onSelectFolder={setSelectedFolder} />

      <MailComposeDialogs compose={compose} />

      <MailComposeDialog compose={compose} accounts={accounts} isMobile={isMobile} onSelectAccount={setSelectedAccount} />

    </div>
  );
};

export default MailPage;
