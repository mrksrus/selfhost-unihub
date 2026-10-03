import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { CalendarDays, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useModules } from '@/hooks/use-modules';
import { browserTimeZone, calendarApi, calendarQueryKeys, type CalendarAccount, type MailCalendarLink } from '@/lib/calendar-api';
import type { MailAccount } from '@/lib/mail-api';
import { calendarSubscriptionHints, type AccountFormState } from '@/components/mail/mail-page-model';

const mailCalendarQueryKey = (mailAccountId: string) => ['mail-calendar', mailAccountId] as const;

const sourceLabels: Record<string, string> = {
  manual: 'entered address',
  provider: 'known provider',
  dns: 'found through DNS',
  'well-known': 'found automatically',
  subscription: 'subscription, read-only',
};

const ago = (value?: string | null) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? formatDistanceToNowStrict(date, { addSuffix: true }) : null;
};

function syncStatusText(account: CalendarAccount) {
  const last = ago(account.last_synced_at);
  switch (account.sync_status) {
    case 'syncing': return { text: 'Syncing…', error: false };
    case 'error': return { text: account.sync_error || 'Sync failed', error: true };
    case 'paused': return { text: account.sync_error || 'Paused', error: false };
    case 'ok': return { text: last ? `Synced ${last}` : 'Synced', error: false };
    default: return { text: last ? `Last sync ${last}` : 'Waiting for the first sync', error: false };
  }
}

/** Address the user entered earlier; discovered and subscription addresses are not shown here. */
const manualAddress = (link?: MailCalendarLink) => {
  const server = link?.account?.provider === 'caldav' ? link.account.provider_config?.server : undefined;
  return server?.source === 'manual' ? server.url : '';
};

/** Calendar of a saved mail account: on/off, status, Sync now and the server address. Changes apply immediately. */
export function MailCalendarSettings({ account }: { account: MailAccount }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isEnabled, isPending: modulesPending } = useModules();
  const calendarModule = !modulesPending && isEnabled('calendar');
  const [address, setAddress] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  const queryKey = mailCalendarQueryKey(account.id);
  const linkQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => calendarApi.fetchMailCalendar(account.id, signal),
    enabled: calendarModule,
  });
  const link = linkQuery.data;

  useEffect(() => { setAddress(manualAddress(link)); }, [link]);

  const refreshCalendar = (next?: MailCalendarLink) => {
    if (next) queryClient.setQueryData(queryKey, next);
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.all });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.accounts });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.calendars });
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.upcomingEvents });
  };

  const change = useMutation({
    mutationFn: (payload: { enabled: boolean; caldav_url?: string }) => (
      calendarApi.setMailCalendar(account.id, { ...payload, time_zone: browserTimeZone() })
    ),
    onSuccess: (next, payload) => {
      refreshCalendar(next);
      if (!payload.enabled) toast({ title: 'Calendar turned off', description: 'Its events were removed from UniHub. Nothing was deleted on the server.' });
      else if (next.account) toast({ title: 'Calendar connected', description: `${next.account.provider_config?.server?.label || 'Server'} · ${next.calendars.length} calendar${next.calendars.length === 1 ? '' : 's'}. Events appear as the first sync finishes.` });
    },
    onError: (error: Error) => toast({ title: 'Calendar not changed', description: error.message, variant: 'destructive', duration: 10000 }),
  });

  const syncNow = useMutation({
    mutationFn: (id: string) => calendarApi.syncAccount(id),
    onSuccess: () => { refreshCalendar(); void linkQuery.refetch(); },
    onError: (error: Error) => { void linkQuery.refetch(); toast({ title: 'Calendar sync failed', description: error.message, variant: 'destructive' }); },
  });

  if (!calendarModule) return null;
  const subscriptionHint = calendarSubscriptionHints[account.provider]
    || (link?.provider && !link.provider.supported ? link.provider.hint : null);
  const busy = change.isPending || syncNow.isPending;
  const calendarAccount = link?.account ?? null;
  const status = calendarAccount ? syncStatusText(calendarAccount) : null;
  const server = calendarAccount?.provider_config?.server;
  const typed = address.trim();
  const addressChanged = calendarAccount ? typed !== manualAddress(link) || (calendarAccount.provider === 'ics' && typed !== '') : false;
  const needsAddress = Boolean(subscriptionHint) && !typed;

  return (
    <section className="rounded-md border border-border p-3 space-y-3" aria-labelledby={`mail-calendar-${account.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <CalendarDays className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" aria-hidden />
          <div className="min-w-0">
            <p id={`mail-calendar-${account.id}`} className="text-sm font-medium text-foreground">Calendar</p>
            <p className="text-xs text-muted-foreground">
              {link?.enabled ? 'Synced with this account. Changes are applied right away.' : 'Sync the calendar of this mail account.'}
            </p>
          </div>
        </div>
        {linkQuery.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading calendar settings" /> : (
          <Switch
            checked={link?.enabled === true}
            disabled={busy || !link || (!link.enabled && needsAddress)}
            aria-labelledby={`mail-calendar-${account.id}`}
            onCheckedChange={(checked) => {
              if (!checked) { setConfirmOff(true); return; }
              change.mutate({ enabled: true, ...(typed ? { caldav_url: typed } : {}) });
            }}
          />
        )}
      </div>

      {linkQuery.error && (
        <p className="text-xs text-destructive">Could not load the calendar settings: {(linkQuery.error as Error).message}</p>
      )}

      {link && calendarAccount && status && (
        <div className="space-y-1 text-xs">
          <p className={status.error ? 'text-destructive' : 'text-muted-foreground'} role={status.error ? 'alert' : undefined}>{status.text}</p>
          {server && (
            <p className="text-muted-foreground break-all">
              Server: {server.label}{sourceLabels[server.source] ? ` (${sourceLabels[server.source]})` : ''}
            </p>
          )}
          <p className="text-muted-foreground">
            {link.calendars.length === 0 ? 'No calendars yet' : link.calendars.map(calendar => calendar.name).join(', ')}
            {` · ${link.event_count} event${link.event_count === 1 ? '' : 's'}`}
          </p>
        </div>
      )}

      {link && (
        <div className="space-y-2">
          <Label htmlFor={`mail-calendar-url-${account.id}`} className="text-xs">
            {subscriptionHint ? 'Calendar subscription address' : 'Calendar server address (optional)'}
          </Label>
          <Input
            id={`mail-calendar-url-${account.id}`}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={calendarAccount?.provider === 'ics'
              ? 'Hidden. Paste a new address to replace it'
              : subscriptionHint ? 'https://… .ics' : 'Found automatically. Enter an address to override'}
            onKeyDown={(event) => {
              // The section sits inside the mail account form; Enter applies the address instead of saving the account.
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (link.enabled && addressChanged && !busy) change.mutate({ enabled: true, caldav_url: typed });
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {subscriptionHint && <p className="text-xs text-muted-foreground">{subscriptionHint}</p>}
          {link.enabled && link.provider?.hint && link.provider.supported && (
            <p className="text-xs text-muted-foreground">{link.provider.hint}</p>
          )}
        </div>
      )}

      {link?.enabled && calendarAccount && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy || (!calendarAccount.is_active && !account.is_active)}
            onClick={() => (calendarAccount.is_active ? syncNow.mutate(calendarAccount.id) : change.mutate({ enabled: true }))}>
            {syncNow.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            {calendarAccount.is_active ? 'Sync now' : 'Resume sync'}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !addressChanged}
            onClick={() => change.mutate({ enabled: true, caldav_url: typed })}>
            {change.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            {typed ? 'Use this address' : 'Find automatically'}
          </Button>
        </div>
      )}
      {change.isPending && <p className="text-xs text-muted-foreground" aria-live="polite">Looking for the calendar server…</p>}

      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off this calendar?</AlertDialogTitle>
            <AlertDialogDescription>
              {`${link?.event_count === 1 ? 'The synced event and its ToDo state are' : `The ${link?.event_count ?? 0} synced events and their ToDo states are`} removed from UniHub. The calendar on the server is not changed, and you can turn it on again later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => change.mutate({ enabled: false })}>Turn off</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** Calendar choice for a new mail account; providers without CalDAV need a subscription address. */
export function MailCalendarAddOption({ form, onChange }: { form: AccountFormState; onChange: (form: AccountFormState) => void }) {
  const { isEnabled, isPending: modulesPending } = useModules();
  if (modulesPending || !isEnabled('calendar')) return null;
  const subscriptionHint = calendarSubscriptionHints[form.provider] || null;
  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <label className="flex items-start gap-3 text-sm">
        <Checkbox
          checked={form.try_calendar_sync}
          onCheckedChange={(checked) => onChange({ ...form, try_calendar_sync: checked === true })}
        />
        <span>
          <span className="font-medium text-foreground">Sync the calendar too</span>
          <span className="block text-muted-foreground">
            {subscriptionHint
              ? 'Optional. Mail is set up either way.'
              : 'Finds the calendar server from your address and uses the same login. Mail is set up even if no calendar is found.'}
          </span>
        </span>
      </label>
      {form.try_calendar_sync && (
        <div className="space-y-2">
          <Label htmlFor="caldav_url">{subscriptionHint ? 'Calendar subscription address' : 'Calendar server address (optional)'}</Label>
          <Input
            id="caldav_url"
            value={form.caldav_url}
            onChange={(e) => onChange({ ...form, caldav_url: e.target.value })}
            placeholder={subscriptionHint ? 'https://… .ics' : 'Found automatically, e.g. https://mail.example.com/dav/'}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            {subscriptionHint || 'Only needed if the server is not found. Subscription addresses (.ics, webcal://) are shown read-only.'}
          </p>
        </div>
      )}
    </div>
  );
}
