import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useModules } from '@/hooks/use-modules';
import { useAppUpdate } from '@/hooks/use-app-update';
import { fetchMailAccounts } from '@/hooks/use-mail-queries';
import { fetchMailWritebacks, groupWritebacks } from '@/hooks/use-mail-writebacks';
import { fetchMailSyncStatus, MAIL_SYNC_JOBS_KEY } from '@/hooks/use-mail-sync-jobs';
import { mailQueryKeys, needsSyncPolicyDecision } from '@/lib/mail-api';
import { calendarApi, calendarQueryKeys } from '@/lib/calendar-api';
import { isOfflineMode } from '@/lib/offline';
import { useAndroidAppUpdate } from '@/lib/install-prompt';
import { downloadFromServer } from '@/lib/platform';

// Everything that waits for the user's decision, collected in one place (the
// bell on the rail, the dot on More on phones) instead of a banner per page.
// Each source links to where the decision is made. A new source (a phone
// waiting to pair, a failed message) adds an entry here.

export interface AttentionItem {
  id: string;
  title: string;
  detail?: string;
  /** Where the user resolves it. */
  href?: string;
  /** Runs instead of following `href`. */
  onAction?: () => void;
  actionLabel: string;
  busy?: boolean;
  error?: string;
  onDismiss?: () => void;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// Other views refresh these queries through live events; the tray only observes.
const OBSERVE = { staleTime: 30_000, refetchInterval: 5 * 60_000, refetchIntervalInBackground: false, retry: false } as const;

export function useAttentionItems(): AttentionItem[] {
  const { user, isOffline } = useAuth();
  const { isEnabled } = useModules();
  const update = useAppUpdate();
  const appUpdate = useAndroidAppUpdate();
  const online = !!user && !isOffline && !isOfflineMode();
  const mailOn = online && isEnabled('mail');
  const calendarOn = online && isEnabled('calendar');

  const accounts = useQuery({ queryKey: mailQueryKeys.accounts, queryFn: fetchMailAccounts, enabled: mailOn, ...OBSERVE }).data ?? [];
  const writebacks = useQuery({ queryKey: mailQueryKeys.writebacks, queryFn: fetchMailWritebacks, enabled: mailOn, ...OBSERVE }).data ?? [];
  const jobs = useQuery({ queryKey: MAIL_SYNC_JOBS_KEY, queryFn: fetchMailSyncStatus, enabled: mailOn && accounts.length > 0, ...OBSERVE }).data ?? [];
  const calendarAccounts = useQuery({ queryKey: calendarQueryKeys.accounts, queryFn: ({ signal }) => calendarApi.fetchAccounts(signal), enabled: calendarOn, ...OBSERVE }).data ?? [];

  const items: AttentionItem[] = [];
  if (mailOn) {
    const attention = groupWritebacks(writebacks).attention.length;
    if (attention) items.push({
      id: 'mail-changes',
      title: `${plural(attention, 'mail change needs', 'mail changes need')} your attention`,
      detail: 'Your mail provider did not confirm them. Retry, accept the server state or discard.',
      href: '/mail?review=attention',
      actionLabel: 'Review',
    });
    const decisions = accounts.filter(needsSyncPolicyDecision);
    if (decisions.length) items.push({
      id: 'mail-decisions',
      title: `${plural(decisions.length, 'mail account needs', 'mail accounts need')} a decision`,
      detail: decisions.map(account => account.email_address).join(', '),
      href: '/mail?review=decision',
      actionLabel: 'Decide',
    });
    for (const job of jobs) {
      const account = accounts.find(entry => entry.id === job.account_id);
      if (job.state !== 'error' || !account?.is_active) continue;
      items.push({
        id: `mail-sync:${account.id}`,
        title: `Mail sync failed for ${account.email_address}`,
        detail: job.error || 'Check the account settings and try again.',
        href: '/mail?review=sync',
        actionLabel: 'Open sync details',
      });
    }
  }
  if (calendarOn) {
    for (const account of calendarAccounts) {
      if (account.sync_status !== 'error' || !account.is_active) continue;
      items.push({
        id: `calendar-sync:${account.id}`,
        title: `Calendar sync failed for ${account.display_name || account.account_email || 'a calendar account'}`,
        detail: account.sync_error || 'Check the account and try again.',
        href: '/calendar',
        actionLabel: 'Open calendar',
      });
    }
  }
  const updateItem = appUpdateItem(update);
  if (updateItem) items.push(updateItem);
  // In the Android app: the server carries a newer app than the one installed.
  if (appUpdate) items.push({
    id: 'android-app-update',
    title: 'Android app update',
    detail: `Version ${appUpdate.versionName} is ready. Open the download to install it over this one.`,
    onAction: () => downloadFromServer(appUpdate.url, 'unihub.apk'),
    actionLabel: 'Download',
  });
  return items;
}

/** The waiting app version, if any, as an attention entry. */
export function appUpdateItem(update: ReturnType<typeof useAppUpdate>): AttentionItem | null {
  if (!update.available) return null;
  return {
    id: 'app-update',
    title: 'UniHub update ready',
    detail: 'Save your edits and let uploads finish, then refresh this tab. Other open tabs keep working until you refresh them.',
    onAction: update.apply,
    actionLabel: update.updating ? 'Updating…' : 'Refresh now',
    busy: update.updating,
    error: update.failed ? 'The update could not be applied yet: another UniHub tab, the Android app or a running request still uses the old version. Close them and try again.' : undefined,
    onDismiss: update.dismiss,
  };
}

