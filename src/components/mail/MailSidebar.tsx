import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Edit, FolderOpen, Loader2, Mail, PenSquare, Trash2, X } from 'lucide-react';
import type { MailAccount } from '@/lib/mail-api';
import { Button } from '@/components/ui/button';
import { ALL_ACCOUNTS, LEGACY_ACCOUNT, getServerDeleteStatus } from '@/components/mail/mail-page-model';

interface SidebarProps {
  isMobile: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  onCompose: () => void;
  /** Account list and folder navigation. */
  children: ReactNode;
}

/** Account and folder column: a collapsible column on desktop, a drawer on phones. */
export function MailSidebar({ isMobile, collapsed, onToggleCollapsed, mobileOpen, onMobileOpenChange, onCompose, children }: SidebarProps) {
  const compact = collapsed && !isMobile;
  return <>
    {/* Mobile Sidebar Overlay */}
    {isMobile && mobileOpen && (
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={() => onMobileOpenChange(false)}
      />
    )}

    <div className={
      isMobile
        ? `fixed left-0 top-0 h-full min-h-0 w-56 z-50 transform overflow-hidden transition-transform duration-200 border-r border-border bg-card flex flex-col ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`
        : `${collapsed ? 'w-16' : 'w-64'} shrink-0 h-full min-h-0 overflow-hidden border-r border-border bg-card flex flex-col transition-all duration-200`
    }>
      {/* Compose Button */}
      <div className={`p-4 flex items-center gap-2 ${compact ? 'flex-col' : ''}`}>
        {isMobile ? (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => onMobileOpenChange(false)}
            title="Close sidebar"
            aria-label="Close account and folder navigation"
          >
            <X className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={onToggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand account and folder navigation' : 'Collapse account and folder navigation'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        )}
        <Button
          className="w-full"
          onClick={onCompose}
          title={compact ? 'Compose' : undefined}
        >
          <PenSquare className={`h-4 w-4 ${compact ? '' : 'mr-2'}`} />
          {!compact && 'Compose'}
        </Button>
      </div>

      {children}
    </div>
  </>;
}

interface AccountListProps {
  accounts: MailAccount[];
  loading: boolean;
  /** The selected view: an account id, `all` or `legacy`. */
  selectedAccount: string | null;
  /** Messages in Legacy; null when unknown. */
  legacyCount: number | null;
  /** Collapsed desktop sidebar: icons only. */
  compact: boolean;
  /** The add account button (the account dialog trigger). */
  addAccount: ReactNode;
  onSelect: (account: string) => void;
  onEdit: (account: MailAccount) => void;
  onRemove: (account: MailAccount) => void;
}

export function MailAccountList({ accounts, loading, selectedAccount, legacyCount, compact, addAccount, onSelect, onEdit, onRemove }: AccountListProps) {
  return (
    <div role="region" aria-label="Mail accounts" className="shrink-0 max-h-[40%] overflow-y-auto">
      <div className={`px-4 pb-2 flex items-center ${compact ? 'justify-center' : 'justify-between'}`}>
        {!compact && (
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Accounts
          </span>
        )}
        {addAccount}
      </div>

      <div className="px-2 space-y-1">
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="px-3 py-4 text-center">
            <Mail className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
            <p className="text-sm text-muted-foreground">No accounts yet</p>
          </div>
        ) : (
          <>
            <div className={`relative group ${compact ? 'flex justify-center' : ''}`}>
              <button
                onClick={() => onSelect(ALL_ACCOUNTS)}
                className={`w-full flex items-center ${compact ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg text-sm transition-colors ${
                  selectedAccount === ALL_ACCOUNTS
                    ? 'bg-mail/10 text-mail font-medium'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
                title={compact ? 'All accounts' : undefined}
              >
                <div className="w-8 h-8 rounded-full bg-mail/10 flex items-center justify-center text-mail text-xs font-medium shrink-0">
                  A
                </div>
                {!compact && (
                  <div className="flex-1 min-w-0 text-left">
                    <p className="truncate">All accounts</p>
                    <p className="text-xs text-muted-foreground truncate">Combined mailbox</p>
                  </div>
                )}
              </button>
            </div>
            {/* Mail the old shared-folder migration could not file. Shown unless it is known to be empty. */}
            {legacyCount !== 0 && <button type="button"
              onClick={() => onSelect(LEGACY_ACCOUNT)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${selectedAccount === LEGACY_ACCOUNT ? 'bg-mail/10 text-mail' : 'text-muted-foreground hover:bg-muted'}`}
              title="Legacy: unresolved mail and mail awaiting a successful server folder check">
              <FolderOpen className="h-5 w-5 shrink-0" />
              {!compact && <span>{legacyCount === null ? 'Legacy' : `Legacy (${legacyCount})`}</span>}
            </button>}
            {accounts.map((account) => (
              <div key={account.id} className={`relative group ${compact ? 'flex justify-center' : ''}`}>
                <button
                  onClick={() => onSelect(account.id)}
                  className={`w-full flex items-center ${compact ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg text-sm transition-colors ${
                    selectedAccount === account.id
                      ? 'bg-mail/10 text-mail font-medium'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                  title={compact ? (account.display_name || account.email_address) : undefined}
                >
                  <div className="w-8 h-8 rounded-full bg-mail/10 flex items-center justify-center text-mail text-xs font-medium shrink-0">
                    {account.unread_count && account.unread_count > 0 && (
                      <motion.span
                        className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-mail"
                        animate={{ opacity: [0.4, 1, 0.4], scale: [0.9, 1.2, 0.9] }}
                        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                      />
                    )}
                    {account.email_address[0].toUpperCase()}
                  </div>
                  {!compact && (
                    <div className="flex-1 min-w-0 text-left">
                      <p className="truncate">{account.display_name || account.email_address}</p>
                      <p className="text-xs text-muted-foreground truncate">{account.email_address}</p>
                      {(account.disconnected_at || !account.is_active) && <p className="text-xs text-warning">Disconnected · local mail retained</p>}
                      {getServerDeleteStatus(account) && (
                        <p className="text-xs text-destructive truncate">{getServerDeleteStatus(account)}</p>
                      )}
                    </div>
                  )}
                </button>
                {!compact && (
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(account);
                      }}
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      title={account.disconnected_at ? 'Preview permanent purge' : 'Disconnect account and retain mail'}
                      aria-label={account.disconnected_at ? `Preview purge for ${account.email_address}` : `Disconnect ${account.email_address}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(account);
                      }}
                    >
                      {account.disconnected_at ? <Trash2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
