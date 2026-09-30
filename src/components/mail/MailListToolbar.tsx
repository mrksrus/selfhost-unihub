import { useState, type ReactNode } from 'react';
import { CheckCircle2, CheckSquare, FolderOpen, Mail, Menu, MoreVertical, Search, Square, Star, Trash2, X } from 'lucide-react';
import type { MailAccount, MailFolder } from '@/lib/mail-api';
import type { MailListView } from '@/hooks/use-mail-list-view';
import type { MailListSelection } from '@/hooks/use-mail-list-selection';
import type { MailBulkActions } from '@/hooks/use-mail-bulk-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { MailFolderItem } from '@/components/mail/mail-page-model';

/** Legacy view: recover checked messages into a receiving account and folder. */
export function MailLegacyRecovery({ accounts, folders, selectedIds, onRecover }: {
  accounts: MailAccount[]; folders: MailFolder[]; selectedIds: string[]; onRecover: (accountId: string, folder: string) => void;
}) {
  const [recoveryAccount, setRecoveryAccount] = useState('');
  const [recoveryFolder, setRecoveryFolder] = useState('inbox');
  return (
    <div className="border-b border-border p-3 space-y-2 text-sm">
      <p>These messages retain their original folders. Some need a receiving account; others await a successful server check. Select messages to recover them. Their original mail source is preserved.</p>
      {selectedIds.length > 0 && <div className="flex flex-wrap gap-2">
        <Select value={recoveryAccount} onValueChange={value => { setRecoveryAccount(value); setRecoveryFolder('inbox'); }}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Receiving account" /></SelectTrigger>
          <SelectContent>{accounts.map(account => <SelectItem key={account.id} value={account.id}>{account.email_address}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={recoveryFolder} onValueChange={setRecoveryFolder}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Destination folder" /></SelectTrigger>
          <SelectContent>{folders.filter(folder => folder.is_system || folder.mail_account_id === recoveryAccount || folder.connected_account_ids?.includes(recoveryAccount)).map(folder =>
            <SelectItem key={folder.slug} value={folder.slug}>{folder.display_name}</SelectItem>)}</SelectContent>
        </Select>
        <Button disabled={!recoveryAccount} onClick={() => onRecover(recoveryAccount, recoveryFolder)}>Recover selected mail</Button>
      </div>}
    </div>
  );
}

interface ToolbarProps {
  isMobile: boolean;
  onOpenSidebar: () => void;
  emailCount: number;
  selection: MailListSelection;
  folderLabel: string;
  accountLabel: string;
  /** The selected account view; filters and search appear once there is one. */
  account: string | null;
  list: MailListView;
  bulk: MailBulkActions;
  /** Folders the checked messages can move to. */
  moveTargets: MailFolderItem[];
  syncControl: ReactNode;
}

/** List header: folder and account, unread filter, search, selection actions and the sync control. */
export function MailListToolbar({ isMobile, onOpenSidebar, emailCount, selection, folderLabel, accountLabel, account, list, bulk,
  moveTargets, syncControl }: ToolbarProps) {
  const { selectedEmails, selectedIds } = selection;
  return (
    <div className="min-h-14 border-b border-border flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenSidebar}
            title="Choose account and folder"
            aria-label="Choose account and folder"
            className="shrink-0"
          >
            <Menu className="h-5 w-5" />
          </Button>
        )}
        {emailCount > 0 && (
          <Button
            variant="ghost"
            size="icon"
            onClick={selection.toggleAll}
            title={selectedEmails.size === emailCount ? 'Deselect all' : 'Select all'}
            className="shrink-0"
          >
            {selectedEmails.size === emailCount ? (
              <CheckSquare className="h-4 w-4" />
            ) : (
              <Square className="h-4 w-4" />
            )}
          </Button>
        )}
        <h2 className="font-semibold shrink-0">{folderLabel}</h2>
        {!selectedEmails.size && account && (
          <span className="text-sm text-muted-foreground min-w-0 truncate">
            {accountLabel}
          </span>
        )}
        {selectedEmails.size > 0 && (
          <span className="text-sm text-muted-foreground shrink-0">
            ({selectedEmails.size} selected)
          </span>
        )}
        {account && !selectedEmails.size && (
          <>
            <Button
              variant={list.showUnreadOnly ? "default" : "outline"}
              size="sm"
              onClick={() => list.setShowUnreadOnly(!list.showUnreadOnly)}
              className="shrink-0"
              title={list.showUnreadOnly ? "Show all emails" : "Show only unread emails"}
            >
              <Mail className="h-4 w-4 mr-2" />
              {list.showUnreadOnly ? 'Unread Only' : 'All'}
            </Button>
            <div className="relative order-last w-full min-w-[180px] sm:order-none sm:ml-4 sm:max-w-md sm:flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search emails..."
                value={list.searchQuery}
                onChange={(e) => list.setSearchQuery(e.target.value)}
                className="pl-9 h-9"
              />
              {list.searchQuery && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                  onClick={() => list.setSearchQuery('')}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {selectedEmails.size > 0 && isMobile && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" title="Selection actions">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70vh] overflow-y-auto">
              <DropdownMenuItem onClick={() => bulk.setRead(selectedIds, true)}>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Mark read
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => bulk.setRead(selectedIds, false)}>
                <Mail className="h-4 w-4 mr-2" />
                Mark unread
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => bulk.star(selectedIds)}>
                <Star className="h-4 w-4 mr-2" />
                Star
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {moveTargets
                .map((folder) => (
                  <DropdownMenuItem
                    key={folder.id}
                    onClick={() => bulk.move(selectedIds, folder.id)}
                  >
                    <folder.icon className="h-4 w-4 mr-2" />
                    Move to {folder.label}
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => bulk.trash(selectedIds)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {selectedEmails.size > 0 && !isMobile && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => bulk.setRead(selectedIds, true)}
              disabled={bulk.readPending(selectedIds, true)}
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Mark Read
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => bulk.setRead(selectedIds, false)}
              disabled={bulk.readPending(selectedIds, false)}
            >
              <Mail className="h-4 w-4 mr-2" />
              Mark Unread
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => bulk.star(selectedIds)}
              disabled={bulk.starPending(selectedIds)}
            >
              <Star className="h-4 w-4 mr-2" />
              Star
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                >
                  <FolderOpen className="h-4 w-4 mr-2" />
                  Move
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {moveTargets
                  .map((folder) => (
                    <DropdownMenuItem
                      key={folder.id}
                      onClick={() => bulk.move(selectedIds, folder.id)}
                    >
                      <folder.icon className="h-4 w-4 mr-2" />
                      Move to {folder.label}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              onClick={() => bulk.trash(selectedIds)}
              disabled={bulk.trashPending(selectedIds)}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </>
        )}
        {syncControl}
      </div>
    </div>
  );
}
