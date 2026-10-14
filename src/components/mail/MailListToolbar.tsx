import { useState, type ReactNode } from 'react';
import { CheckCircle2, CheckSquare, FolderOpen, Mail, PenSquare, Search, Square, Star, Trash2, X } from 'lucide-react';
import type { MailAccount, MailFolder } from '@/lib/mail-api';
import type { MailListView } from '@/hooks/use-mail-list-view';
import type { MailListSelection } from '@/hooks/use-mail-list-selection';
import type { MailBulkActions } from '@/hooks/use-mail-bulk-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/layout/PageShell';
import { usePagePanel } from '@/components/layout/page-panel';
import { cn } from '@/lib/utils';
import type { MailFolderItem } from '@/components/mail/mail-page-model';

/** Legacy view: recover checked messages into a receiving account and folder. */
export function MailLegacyRecovery({ accounts, folders, selectedIds, onRecover }: {
  accounts: MailAccount[]; folders: MailFolder[]; selectedIds: string[]; onRecover: (accountId: string, folder: string) => void;
}) {
  const [recoveryAccount, setRecoveryAccount] = useState('');
  const [recoveryFolder, setRecoveryFolder] = useState('inbox');
  return (
    <div className="border-b border-border px-4 py-3 space-y-2 text-sm md:px-6">
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
  /** Compose moves into the header while the panel (which offers it) is folded away. */
  onCompose: () => void;
}

const chip = (on: boolean) => cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  on ? 'border-transparent bg-muted text-foreground' : 'border-border text-muted-foreground hover:text-foreground');

/**
 * The page header of Mail: folder and account, then a row with the unread
 * filter and search, or with the actions for checked messages.
 */
export function MailListToolbar({ emailCount, selection, folderLabel, accountLabel, account, list, bulk,
  moveTargets, syncControl, onCompose }: ToolbarProps) {
  const { selectedEmails, selectedIds } = selection;
  const selecting = selectedEmails.size > 0;
  const allSelected = emailCount > 0 && selectedEmails.size === emailCount;
  const { folded } = usePagePanel();
  return (
    <PageHeader title={folderLabel} scope={accountLabel} actions={<>
      {folded && <Button size="sm" onClick={onCompose}><PenSquare aria-hidden="true" />Compose</Button>}
      {syncControl}
    </>}>
      {(account || emailCount > 0) && <div className="flex min-h-12 flex-wrap items-center gap-2 px-4 pb-2 md:px-6">
        {emailCount > 0 && (
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={selection.toggleAll}
            aria-label={allSelected ? 'Deselect all' : 'Select all'} title={allSelected ? 'Deselect all' : 'Select all'}>
            {allSelected ? <CheckSquare aria-hidden="true" className="text-accent" /> : <Square aria-hidden="true" />}
          </Button>
        )}
        {selecting ? <>
          <span className="mr-1 text-sm font-medium">{selectedEmails.size} selected</span>
          <Button variant="outline" size="sm" aria-label="Mark selected as read" onClick={() => bulk.setRead(selectedIds, true)} disabled={bulk.readPending(selectedIds, true)}>
            <CheckCircle2 aria-hidden="true" /><span className="hidden sm:inline">Read</span>
          </Button>
          <Button variant="outline" size="sm" aria-label="Mark selected as unread" onClick={() => bulk.setRead(selectedIds, false)} disabled={bulk.readPending(selectedIds, false)}>
            <Mail aria-hidden="true" /><span className="hidden sm:inline">Unread</span>
          </Button>
          <Button variant="outline" size="sm" aria-label="Star selected" onClick={() => bulk.star(selectedIds)} disabled={bulk.starPending(selectedIds)}>
            <Star aria-hidden="true" /><span className="hidden sm:inline">Star</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" aria-label="Move selected"><FolderOpen aria-hidden="true" /><span className="hidden sm:inline">Move</span></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[60vh] overflow-y-auto">
              {moveTargets.map((folder) => (
                <DropdownMenuItem key={folder.id} onClick={() => bulk.move(selectedIds, folder.id, undefined, folder.label)}>
                  <folder.icon className="mr-2 h-4 w-4" />Move to {folder.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" aria-label="Delete selected" onClick={() => bulk.trash(selectedIds)} disabled={bulk.trashPending(selectedIds)}
            className="text-destructive hover:text-destructive">
            <Trash2 aria-hidden="true" /><span className="hidden sm:inline">Delete</span>
          </Button>
        </> : account && <>
          <button type="button" className={chip(list.showUnreadOnly)} aria-pressed={list.showUnreadOnly}
            onClick={() => list.setShowUnreadOnly(!list.showUnreadOnly)}>
            Unread only
          </button>
          <div className="relative min-w-[180px] flex-1 md:max-w-md">
            <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" placeholder="Search mail" aria-label="Search mail" value={list.searchQuery}
              onChange={(e) => list.setSearchQuery(e.target.value)} className="h-9 pl-9 pr-9" />
            {list.searchQuery && (
              <Button variant="ghost" size="icon" className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2" aria-label="Clear search"
                onClick={() => list.setSearchQuery('')}><X aria-hidden="true" /></Button>
            )}
          </div>
        </>}
      </div>}
    </PageHeader>
  );
}
