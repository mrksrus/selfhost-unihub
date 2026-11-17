import { useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useCalendarShareCandidates } from '@/hooks/use-calendar-shares';
import { useMyGroups } from '@/hooks/use-organisation';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { invalidateCalendarQueries, type CalendarCalendar } from '@/lib/calendar-api';
import { calendarSharesApi } from '@/lib/calendar-shares-api';
import { fetchGroup, groupsQueryKeys } from '@/lib/groups-api';
import { isReached } from '@/components/calendar/calendar-access';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioRow } from '@/components/ui/radio';

/**
 * Hands a person's calendar to someone else. Its owner offers it to a person
 * within their reach, who accepts or declines. A manager of a group the
 * calendar is shared with offers it to a member of that group, or hands it
 * over at once. The server decides who may; a refusal shows its sentence.
 * Mounted while open, so every opening starts empty.
 */
export function HandOverDialog({ calendar, onClose }: { calendar: CalendarCalendar; onClose: () => void }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const own = !isReached(calendar);
  const reach = useCalendarShareCandidates(calendar.id, query, own);
  const managed = (useMyGroups().data ?? []).filter(group => group.role === 'manager');
  const groups = useQueries({
    queries: own ? [] : managed.map(group => ({ queryKey: groupsQueryKeys.group(group.id), queryFn: ({ signal }: { signal: AbortSignal }) => fetchGroup(group.id, signal) })),
  });
  const needle = query.trim().toLowerCase();
  const people = own ? reach.data?.people ?? []
    : [...new Map(groups.flatMap(group => group.data?.members ?? []).map(member => [member.id, member])).values()]
      .filter(member => member.id !== calendar.owner?.id && `${member.full_name ?? ''} ${member.email}`.toLowerCase().includes(needle));
  const loading = own ? reach.isLoading : groups.some(group => group.isLoading);

  const hand = useSessionMutation({
    mutationFn: (now: boolean) => calendarSharesApi.handOver(calendar.id, { to: chosen!.id, ...(now ? { now } : {}) }),
    onSuccess: (_offer, now) => {
      void invalidateCalendarQueries(client);
      toast(now ? { title: `${calendar.name} now belongs to ${chosen?.name}`, description: 'Its former owner was told and can still edit it.' }
        : { title: `${calendar.name} offered to ${chosen?.name}`, description: 'It changes hands when they accept.' });
      onClose();
    },
    onError: (error: Error) => toast({ title: 'Could not hand over the calendar', description: error.message, variant: 'destructive' }),
  });

  return (
    <Dialog open onOpenChange={open => { if (!open && !hand.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Hand over {calendar.name}</DialogTitle>
          <DialogDescription>
            {own ? 'Offer this calendar to someone. When they accept, it is theirs with all its events. You can still edit it, and everyone it is shared with keeps it.'
              : 'This calendar is shared with a group you manage. Offer it to a member of that group, or hand it over at once. Its owner is told and can still edit it.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="hand-over-search">New owner</Label>
          <Input id="hand-over-search" type="search" autoComplete="off" placeholder="Name or email" value={query} onChange={event => setQuery(event.target.value)} />
          {own && reach.error ? <p role="alert" className="py-2 text-sm text-destructive">{reach.error.message}</p>
            : loading ? <p role="status" className="py-2 text-sm text-muted-foreground">Searching…</p>
            : people.length === 0 ? <p className="py-2 text-sm text-muted-foreground">{own ? 'Nobody you can share with matches.' : 'No member of your groups matches.'}</p>
            : (
              <div role="radiogroup" aria-label="New owner" className="max-h-56 overflow-y-auto">
                {people.slice(0, 20).map(person => (
                  <RadioRow key={person.id} id={`hand-over-${person.id}`} name="hand-over-to" label={person.full_name || person.email} description={person.full_name ? person.email : undefined}
                    checked={chosen?.id === person.id} onChange={() => setChosen({ id: person.id, name: person.full_name || person.email })} />
                ))}
              </div>
            )}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" className="sm:mr-auto" onClick={onClose} disabled={hand.isPending}>Cancel</Button>
          {!own && <Button type="button" variant="outline" disabled={!chosen || hand.isPending} onClick={() => hand.mutate(true)}>Hand over now</Button>}
          <Button type="button" disabled={!chosen || hand.isPending} onClick={() => hand.mutate(false)}>{hand.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Offer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
