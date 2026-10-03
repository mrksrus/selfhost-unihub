import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Mail, ShieldAlert } from 'lucide-react';
import type { MailAccount } from '@/lib/mail-api';
import { useMailFolders, useMailUnreadCounts } from '@/hooks/use-mail-queries';
import { ALL_ACCOUNTS, ALL_MAIL, LEGACY_ACCOUNT, systemFolders, type FolderMode, type MailFolderItem } from '@/components/mail/mail-page-model';

/**
 * The selected folder and the folders shown for the selected account view
 * (one account, all accounts, or Legacy), with move targets and unread counts.
 */
export function useMailFolderView(selectedAccount: string | null, accounts: MailAccount[]) {
  const [selectedFolder, setSelectedFolder] = useState<FolderMode>('inbox');
  const { data: loadedFolders, isError: foldersFailed } = useMailFolders();
  const mailFolders = useMemo(() => loadedFolders ?? [], [loadedFolders]);
  const foldersLoaded = loadedFolders !== undefined;

  // null: unknown because the folders could not be loaded, so Legacy stays reachable.
  const legacyCount = !foldersLoaded && foldersFailed ? null
    : mailFolders.reduce((total, folder) => total + (folder.legacy_count || 0), 0);
  const visibleMailFolders = useMemo(() => mailFolders.filter(folder => {
    if (selectedAccount === LEGACY_ACCOUNT) return (folder.legacy_count || 0) > 0;
    if (folder.is_system) return true;
    const linked = folder.connected_account_ids || [];
    if (selectedAccount === ALL_ACCOUNTS) return !!folder.mail_account_id || linked.length > 0 || (folder.legacy_count || 0) > 0;
    return folder.mail_account_id === selectedAccount || linked.includes(selectedAccount || '');
  }), [mailFolders, selectedAccount]);

  const folders = useMemo<MailFolderItem[]>(() => {
    const systemBySlug = new Map(systemFolders.map(folder => [folder.id, folder]));
    if (mailFolders.length === 0) return systemFolders.map(folder => ({ ...folder, legacy: false, accountId: null as string | null }));
    return visibleMailFolders.map((folder) => {
      const systemFolder = systemBySlug.get(folder.special_use || folder.slug);
      const account = accounts.find(account => account.id === folder.mail_account_id);
      return {
        id: folder.slug,
        label: selectedAccount === ALL_ACCOUNTS && account ? `${folder.display_name} · ${account.email_address}` : folder.display_name,
        icon: folder.special_use === 'junk' ? ShieldAlert : systemFolder?.icon || FolderOpen,
        legacy: false,
        accountId: folder.mail_account_id || null,
      };
    }).sort((a, b) => Number(a.legacy) - Number(b.legacy));
  }, [mailFolders, visibleMailFolders, selectedAccount, accounts]);

  useEffect(() => {
    if (mailFolders.length && selectedFolder !== ALL_MAIL && selectedFolder !== 'starred' && !visibleMailFolders.some(folder => folder.slug === selectedFolder)) {
      setSelectedFolder(selectedAccount === LEGACY_ACCOUNT ? ALL_MAIL : 'inbox');
    }
  }, [mailFolders, visibleMailFolders, selectedFolder, selectedAccount]);

  const folderFilters = useMemo<MailFolderItem[]>(() => {
    // Starred is a virtual IMAP flag view, not a physical mailbox row.
    const starred = { ...systemFolders.find(folder => folder.id === 'starred')!, legacy: false, accountId: null };
    const listedFolders = folders.filter(folder => folder.id !== 'starred');
    const insertAfter = listedFolders.findIndex(folder => folder.id === 'drafts') + 1;
    const orderedFolders = [
      ...listedFolders.slice(0, Math.max(insertAfter, 0)),
      starred,
      ...listedFolders.slice(Math.max(insertAfter, 0)),
    ];
    return [{ id: ALL_MAIL, label: 'All mail', icon: Mail, legacy: false, accountId: null }, ...orderedFolders];
  }, [folders]);

  const movableFolderIds = useMemo(
    () => selectedAccount === LEGACY_ACCOUNT ? [] : folders.filter(folder => !folder.accountId || folder.accountId === selectedAccount).map(folder => folder.id).filter(folderId => folderId !== 'starred'),
    [folders, selectedAccount]
  );

  const { data: unreadCountsData } = useMailUnreadCounts(selectedAccount);
  const unreadByFolder = unreadCountsData?.unreadByFolder || {};

  return {
    selectedFolder, setSelectedFolder, mailFolders, foldersLoaded, legacyCount, visibleMailFolders, folders, folderFilters, movableFolderIds, unreadByFolder,
  };
}
