import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useAdminCalendars } from '@/hooks/use-calendar-shares';
import { useModules } from '@/hooks/use-modules';
import { useAdminGroups } from '@/hooks/use-organisation';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { invalidateCalendarQueries } from '@/lib/calendar-api';
import { calendarSharesApi } from '@/lib/calendar-shares-api';
import { can } from '@/lib/permissions';
import { formatDay } from '@/components/admin/person-words';
import { calendarMeta, useSharedCalendarActions } from '@/components/calendar/SharedCalendarActions';
import { SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';

// Server › Calendars: the calendars of the organisation and of its groups,
// which administrators make and manage, and every person's calendar that is
// shared with someone, by name and counts only: an administrator hands such
// a calendar to someone else or archives it, and never opens it here. A
// deleted organisation or group calendar waits here until it is purged.

const AdminCalendars = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const calendarOn = useModules().isEnabled('calendar');
  const calendars = useAdminCalendars();
  const groups = useAdminGroups();
  const actions = useSharedCalendarActions();
  const restore = useSessionMutation({
    mutationFn: calendarSharesApi.adminRestore,
    onSuccess: calendar => { void invalidateCalendarQueries(client); toast({ title: `${calendar.name} restored`, description: 'It is back with its events for everyone it was shared with.' }); },
    onError: (error: Error) => toast({ title: 'Could not restore the calendar', description: error.message, variant: 'destructive' }),
  });
  const live = calendars.data?.filter(calendar => !calendar.deleted_at) ?? [];
  const shared = live.filter(calendar => calendar.owner_kind !== 'user');
  const personal = live.filter(calendar => calendar.owner_kind === 'user');
  const deleted = calendars.data?.filter(calendar => calendar.deleted_at) ?? [];

  return (
    <PageShell panel={<SettingsPanel active="admin-calendars" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope="Calendars" />
      <PageBody width="reading">
        {!can(user, 'calendars.manage') ? <p className="text-sm text-muted-foreground">Only administrators can see this page.</p>
          : !calendarOn ? <p className="text-sm text-muted-foreground">Calendar is switched off for your account. Switch it on under Settings › Pages and modules to manage calendars here.</p> : (
          <>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">Calendars</h2>
                <p className="mt-1 max-w-prose text-sm text-muted-foreground">Calendars of the organisation and of its groups. They belong to nobody in person, so they stay when people leave. A group's calendar is also managed by the group's managers.</p>
              </div>
              <Button onClick={() => actions.open({ action: 'new', groupId: null, groups: groups.data ?? [] })}><Plus aria-hidden="true" />New calendar</Button>
            </div>
            {calendars.isLoading ? <LoadingState label="Loading the calendars…" />
              : calendars.error ? <ErrorState title="Could not load the calendars" error={calendars.error} onRetry={() => void calendars.refetch()} retrying={calendars.isFetching} />
              : (
                <>
                  {shared.length === 0 ? <EmptyState icon={CalendarDays} title="No organisation or group calendars yet" description="Make one for everyone, or for a group whose members plan together." />
                    : <ul aria-label="Organisation and group calendars" className="mb-10 divide-y divide-border border-y border-border">{shared.map(calendar => actions.row(calendar, calendarMeta(calendar), { manage: true, admin: true }))}</ul>}
                  {personal.length > 0 && (
                    <SettingsSection title="Shared by people" description="A person's calendar is listed while it is shared with someone, by its name and numbers; its events stay closed to you. You can hand it to someone else or archive it, and its owner is told.">
                      <ul aria-label="Calendars shared by people" className="divide-y divide-border">{personal.map(calendar => actions.row(calendar, calendarMeta(calendar), { admin: true }))}</ul>
                    </SettingsSection>
                  )}
                  {deleted.length > 0 && (
                    <SettingsSection title="Deleted" description="Hidden for everyone. A deleted calendar is kept as long as a shared calendar's bin keeps its events, and then deleted for good with them. Restore brings it back with its events and shares.">
                      {deleted.map(calendar => (
                        <SettingsRow key={calendar.id} label={calendar.name} description={`${calendarMeta(calendar)}, deleted ${formatDay(calendar.deleted_at!)}`}>
                          <Button variant="outline" size="sm" disabled={restore.isPending} aria-label={`Restore ${calendar.name}`} onClick={() => restore.mutate(calendar.id)}>Restore</Button>
                        </SettingsRow>
                      ))}
                    </SettingsSection>
                  )}
                </>
              )}
          </>
        )}
      </PageBody>
      {actions.dialogs}
    </PageShell>
  );
};

export default AdminCalendars;
