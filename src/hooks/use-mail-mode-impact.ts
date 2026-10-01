import { skipToken, useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  DEFAULT_SYNC_WINDOW_DAYS, DEFAULT_TRASH_WINDOW_DAYS, addressMatches, fetchMailModeImpact,
  type MailAccount, type MailWindowDays,
} from '@/lib/mail-api';

export const accountSyncWindow = (account: MailAccount): MailWindowDays =>
  account.sync_window_days === undefined ? DEFAULT_SYNC_WINDOW_DAYS : account.sync_window_days;
export const accountTrashWindow = (account: MailAccount): MailWindowDays =>
  account.trash_window_days === undefined ? DEFAULT_TRASH_WINDOW_DAYS : account.trash_window_days;

/**
 * Pre-save review of a mode or window change on an existing account. New
 * accounts have no local mail, so they need no review. Window changes are
 * debounced; Save stays blocked until the counts for the current choice are in
 * and, where mail would be removed or Sync switched on, the address is typed.
 */
export function useMailModeImpact({ account, mode, syncWindow, trashWindow, typedAddress, serverRequiresConfirmation }: {
  account: MailAccount | null;
  mode: 'download' | 'sync';
  syncWindow: MailWindowDays;
  trashWindow: MailWindowDays;
  typedAddress: string;
  serverRequiresConfirmation: boolean;
}) {
  const currentMode = account?.sync_mode || 'download';
  const switchingToSync = Boolean(account) && currentMode !== 'sync' && mode === 'sync';
  const windowsChanged = Boolean(account) && mode === 'sync'
    && (syncWindow !== accountSyncWindow(account!) || trashWindow !== accountTrashWindow(account!));
  const needed = Boolean(account) && (currentMode !== mode || windowsChanged);
  const choice = `${mode}|${syncWindow ?? 'all'}|${trashWindow ?? 'all'}`;
  const settled = useDebouncedValue(choice, 400);
  const ready = needed && settled === choice;
  const query = useQuery({
    queryKey: ['mail-mode-impact', account?.id ?? null, choice],
    queryFn: ready && account
      ? ({ signal }) => fetchMailModeImpact(account.id, { mode, syncWindow, trashWindow }, signal)
      : skipToken,
    retry: false,
    staleTime: 0,
    gcTime: 60_000,
  });
  const loading = needed && (!ready || query.isPending);
  const error = needed && query.isError ? query.error.message : null;
  const impact = needed ? query.data ?? null : null;
  const requiresAddress = serverRequiresConfirmation
    || (needed && (switchingToSync || Boolean(error) || (impact?.total_removals ?? 0) > 0));
  const addressOk = Boolean(account) && addressMatches(typedAddress, account!);
  return {
    needed, visible: needed || serverRequiresConfirmation, switchingToSync, loading, error, impact, requiresAddress, addressOk,
    retry: () => { void query.refetch(); },
    /** Save is allowed once the impact is known (or failed visibly) and any required address matches. */
    blocked: (needed && loading) || (requiresAddress && !addressOk),
  };
}

export type MailModeImpactReview = ReturnType<typeof useMailModeImpact>;
