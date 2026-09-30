import { useCallback, useState } from 'react';

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
