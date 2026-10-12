import type { ReactNode } from 'react';
import { FolderOpen, Inbox, Loader2, Pencil, PenSquare, Trash2, Users, X } from 'lucide-react';
import type { MailAccount } from '@/lib/mail-api';
import { Button } from '@/components/ui/button';
import { PanelGroup, PanelHeader, PanelItem } from '@/components/layout/PageShell';

import { ALL_ACCOUNTS, LEGACY_ACCOUNT, getServerDeleteStatus } from '@/components/mail/mail-page-model';

/** Mail's context panel: write, accounts, then folders. */
export function MailPanel({ onCompose, children }: { onCompose: () => void; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Mail" action={<Button size="sm" onClick={onCompose}><PenSquare aria-hidden="true" />Compose</Button>} />
      {children}
    </div>
  );
}

interface AccountListProps {
  accounts: MailAccount[];
  loading: boolean;
  /** The selected view: an account id, `all` or `legacy`. */
  selectedAccount: string | null;
  /** Messages in Legacy; null when unknown. */
  legacyCount: number | null;
  /** The add account button (the account dialog trigger). */
  addAccount: ReactNode;
  onSelect: (account: string) => void;
  onEdit: (account: MailAccount) => void;
  onRemove: (account: MailAccount) => void;
}

function AccountState({ account }: { account: MailAccount }) {
  const serverDelete = getServerDeleteStatus(account);
  return <>
    <span className="block truncate">{account.email_address}</span>
    {account.disconnected_at ? <span className="block text-warning">Disconnected · local mail retained</span>
      : !account.is_active && <span className="block text-warning">Paused · edit the account to reconnect</span>}
    {serverDelete && <span className="block truncate text-destructive">{serverDelete}</span>}
  </>;
}

export function MailAccountList({ accounts, loading, selectedAccount, legacyCount, addAccount, onSelect, onEdit, onRemove }: AccountListProps) {
  return (
    <div role="region" aria-label="Mail accounts" className="shrink-0 max-h-[40%] overflow-y-auto">
      <PanelGroup label="Accounts" action={addAccount}>
        {loading ? (
          <div className="flex justify-center py-3"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : accounts.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">No accounts yet. Add one to start.</p>
        ) : <>
          <PanelItem icon={Users} active={selectedAccount === ALL_ACCOUNTS} onSelect={() => onSelect(ALL_ACCOUNTS)} description="Combined view">
            All accounts
          </PanelItem>
          {/* Mail the old shared-folder migration could not file. Shown unless it is known to be empty. */}
          {legacyCount !== 0 && (
            <PanelItem icon={FolderOpen} active={selectedAccount === LEGACY_ACCOUNT} onSelect={() => onSelect(LEGACY_ACCOUNT)}
              title="Legacy: unresolved mail and mail awaiting a successful server folder check">
              {legacyCount === null ? 'Legacy' : `Legacy (${legacyCount})`}
            </PanelItem>
          )}
          {accounts.map(account => (
            <PanelItem key={account.id} icon={Inbox} active={selectedAccount === account.id} onSelect={() => onSelect(account.id)}
              description={<AccountState account={account} />}
              trailing={<>
                <Button variant="ghost" size="icon" className="h-7 w-7 bg-card" aria-label={`Edit ${account.email_address}`}
                  onClick={() => onEdit(account)}><Pencil aria-hidden="true" /></Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 bg-card text-destructive hover:text-destructive"
                  title={account.disconnected_at ? 'Delete local data' : 'Disconnect account'}
                  aria-label={account.disconnected_at ? `Delete local data of ${account.email_address}` : `Disconnect ${account.email_address}`}
                  onClick={() => onRemove(account)}>
                  {account.disconnected_at ? <Trash2 aria-hidden="true" /> : <X aria-hidden="true" />}
                </Button>
              </>}>
              {account.display_name || account.email_address}
            </PanelItem>
          ))}
        </>}
      </PanelGroup>
    </div>
  );
}
