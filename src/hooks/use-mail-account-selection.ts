import { useCallback, useEffect, useState } from 'react';

export type MailAccountSelection =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'legacy' }
  | { kind: 'account'; id: string };

export function parseMailAccountSelection(value: string | null): MailAccountSelection {
  if (!value) return { kind: 'none' };
  if (value === 'all' || value === 'legacy') return { kind: value };
  return { kind: 'account', id: value };
}

// Strings only cross the existing query/storage interface. Data-changing
// workflows use accountId, which virtual views cannot supply.
export function useMailAccountSelection() {
  const [selection, setSelection] = useState<MailAccountSelection>({ kind: 'none' });
  const selectAccount = useCallback((value: string | null) => setSelection(parseMailAccountSelection(value)), []);
  const accountId = selection.kind === 'account' ? selection.id : null;
  const queryAccount = selection.kind === 'none' ? null : selection.kind === 'account' ? selection.id : selection.kind;
  return { selection, accountId, queryAccount, selectAccount };
}

const LAST_ACCOUNT_KEY = 'mail_last_selected_account';

/**
 * Restores the last selected account view once accounts are known, then
 * remembers each later choice. Legacy has no Inbox, so restoring it also
 * selects All mail through `selectFolder` (a stable state setter).
 */
export function useRememberedMailAccount(accounts: { id: string }[], selected: string | null,
  select: (value: string | null) => void, selectFolder: (folder: string) => void) {
  useEffect(() => {
    if (accounts.length > 0 && !selected) {
      const lastAccountId = localStorage.getItem(LAST_ACCOUNT_KEY);
      const lastAccount = accounts.find(a => a.id === lastAccountId);

      if (lastAccountId === 'legacy') {
        select('legacy');
        selectFolder('all');
      } else if (lastAccountId === 'all') {
        select('all');
      } else if (lastAccount) {
        select(lastAccount.id);
      } else {
        // Default to all accounts
        select('all');
      }
    }
  }, [accounts, selected, select, selectFolder]);

  useEffect(() => {
    if (selected) {
      localStorage.setItem(LAST_ACCOUNT_KEY, selected);
    }
  }, [selected]);
}
