import { useContext, useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarDays, CalendarRange, CheckCircle2, CloudOff, Loader2, Mic, MoreHorizontal, Trash2, UserRound } from 'lucide-react';
import { AuthContext } from '@/contexts/auth-context';
import { usePolicy } from '@/hooks/use-policies';
import { useBinActions, type DestinationAsk } from '@/hooks/use-bin-actions';
import { BIN_MODULES, binQueryOptions, groupBinItems, retentionSentence, type BinItem, type BinModule } from '@/lib/bin-api';
import { calendarApi, calendarQueryKeys, type CalendarCalendar } from '@/lib/calendar-api';
import { ListChooser } from '@/components/todo/ListChooser';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { buttonVariants } from '@/components/ui/button-variants';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { PolicyNote, PolicyMenuItem } from '@/components/ui/policy-note';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { settingsHref } from '@/components/settings/settings-sections';

const ICONS: Record<BinItem['item_type'], typeof UserRound> = { contact: UserRound, event: CalendarDays, task: CheckCircle2, recording: Mic, calendar: CalendarRange };
const KINDS: Record<BinItem['item_type'], string> = { contact: 'contact', event: 'event', task: 'task', recording: 'recording', calendar: 'calendar' };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const formatDay = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
};

/** The lines under a binned item or group: when it goes, where it came from, what restoring does. */
function itemMeta(lead: BinItem, group: BinItem[]) {
  const lines: string[] = [];
  const when = `Deleted ${formatDay(lead.deleted_at)}`;
  lines.push(lead.purge_after ? `${when} · gone for good ${formatDay(lead.purge_after)}` : `${when} · kept until you restore or delete it`);
  const kinds = group.length > 1 ? `With ${plural(group.length - 1, 'item')}: ${group.slice(1).map(item => item.title).join(', ')}` : null;
  if (kinds) lines.push(kinds);
  const where = [lead.reason === 'merged' ? 'Merged into another contact' : lead.reason === 'calendar_deleted' && lead.item_type !== 'calendar' ? 'Deleted with its calendar' : null, lead.origin]
    .filter(Boolean).join(' · ');
  if (where) lines.push(where);
  if (lead.provider === 'caldav') lines.push('Restoring creates it on the calendar server again.');
  return lines;
}

type Confirm = { title: string; description: string; action: string; run: () => void };

/** Why a calendar cannot take the items asked about: a synced item needs a server calendar, a UniHub item a UniHub list. */
function wrongKind(calendar: CalendarCalendar, kind: DestinationAsk['kind']) {
  const provider = calendar.account_provider ?? 'local';
  if (kind === 'calendar' && provider === 'local') return 'A UniHub list cannot hold a synced item';
  if (kind === 'list' && provider !== 'local') return 'Only a UniHub list can hold it';
  return null;
}

/**
 * Where restored events or tasks should go when the server cannot put them
 * back where they were: the calendar is gone or read-only
 * (BIN_RESTORE_NEEDS_CALENDAR), or a UniHub item needs a UniHub list
 * (BIN_RESTORE_NEEDS_LIST). The person's calendars and lists, with the ones
 * that cannot take the items greyed out and saying why.
 */
function DestinationDialog({ ask, titles, pending, onClose, onChoose, returnFocus }: {
  ask: DestinationAsk | null; titles: string[]; pending: boolean; onClose: () => void; onChoose: (calendarId: string) => void;
  /** Where focus goes when the dialog closes: the control that opened it, or the list when its row is gone. */
  returnFocus: () => void;
}) {
  const id = useId();
  const [chosen, setChosen] = useState('');
  const open = !!ask;
  const calendars = useQuery({ queryKey: calendarQueryKeys.calendars, queryFn: ({ signal }) => calendarApi.fetchCalendars(signal), enabled: open });
  const unavailable = Object.fromEntries((calendars.data ?? []).flatMap(calendar => { const why = ask && wrongKind(calendar, ask.kind); return why ? [[calendar.id, why]] : []; }));
  const what = titles.length === 1 ? titles[0] : `${titles.length} items`;
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !pending) { setChosen(''); onClose(); } }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
        <DialogHeader>
          <DialogTitle>Where should {titles.length === 1 ? 'it' : 'they'} go?</DialogTitle>
          <DialogDescription>
            {ask?.kind === 'list'
              ? `${what} belongs to UniHub, so it needs one of your UniHub lists.`
              : `The calendar ${what} came from is gone or read-only. Choose one of your calendars on a server; the item is created there again.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label htmlFor={id} className="text-sm font-medium">{ask?.kind === 'list' ? 'List' : 'Calendar'}</label>
          {calendars.isLoading ? <LoadingState compact label="Loading your calendars…" />
            : calendars.error ? <ErrorState title="Could not load your calendars" error={calendars.error} onRetry={() => void calendars.refetch()} retrying={calendars.isFetching} />
            : <ListChooser id={id} calendars={calendars.data ?? []} value={chosen} onChange={setChosen} unavailable={unavailable} placeholder={ask?.kind === 'list' ? 'Choose a list' : 'Choose a calendar'} disabled={pending} />}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={() => { setChosen(''); onClose(); }} disabled={pending}>Not now</Button>
          <Button type="button" disabled={!chosen || pending} onClick={() => { onChoose(chosen); setChosen(''); }}>
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}Restore there
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The bin of one module, or of everything (Settings → Bin): rows with
 * Restore and, under the bin.delete policy, Delete for good and Empty bin.
 * A group (a merge, a calendar with its events) is one row and comes back
 * as a unit. Binned items are not in the offline copy, so the view needs a
 * connection.
 */
export function BinView({ module, showSettingsLink = true }: { module?: BinModule; showSettingsLink?: boolean }) {
  const isOffline = !!useContext(AuthContext)?.isOffline;
  const query = useQuery({ ...binQueryOptions(module), enabled: !isOffline });
  const [ask, setAsk] = useState<DestinationAsk | null>(null);
  const actions = useBinActions(module, { onDestinationAsked: setAsk });
  const deletePolicy = usePolicy('bin.delete');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // The Restore button that opened the destination dialog, and the list to fall back to.
  const opener = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const returnFocus = () => {
    const target = opener.current?.isConnected ? opener.current : list.current?.querySelector<HTMLElement>('button') ?? list.current;
    target?.focus();
  };
  // An ask names only items still in the bin: one restored or deleted elsewhere since (a refetch
  // dropped it) is left out, and an ask with nothing left closes.
  const items = query.data?.items;
  const liveAsk = ask && items ? { ...ask, ids: ask.ids.filter(id => items.some(item => item.id === id)) } : ask;
  const askEmpty = !!liveAsk && liveAsk.ids.length === 0;
  useEffect(() => { if (askEmpty) setAsk(null); }, [askEmpty]);

  if (isOffline) return <EmptyState icon={CloudOff} title="The bin needs a connection" description="Deleted items are kept on the server, not in the offline copy." />;
  if (query.isLoading) return <LoadingState label="Loading the bin…" />;
  if (query.error) return <ErrorState title="Could not load the bin" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  const { items: binItems, retention } = query.data!;
  const groups = groupBinItems(binItems);
  const shownAsk = liveAsk && liveAsk.ids.length > 0 ? liveAsk : null;
  const askedTitles = shownAsk ? shownAsk.ids.map(id => { const item = binItems.find(entry => entry.id === id); return item?.title || `an ${KINDS[item?.item_type ?? 'event']}`; }) : [];
  const moduleLabel = (id: BinModule) => BIN_MODULES.find(entry => entry.id === id)?.label ?? id;

  const confirmEmpty = () => setConfirm({
    title: module ? `Empty the ${moduleLabel(module).toLowerCase()} bin?` : 'Empty the bin?',
    description: `${plural(binItems.length, 'item')} ${binItems.length === 1 ? 'is' : 'are'} deleted for good. Nothing can be restored afterwards.`,
    action: 'Delete for good', run: () => actions.empty.mutate(module),
  });
  const confirmDelete = (group: BinItem[]) => setConfirm({
    title: `Delete ${group[0].title || `this ${KINDS[group[0].item_type]}`} for good?`,
    description: group.length > 1 ? `${plural(group.length, 'item')} are deleted for good and cannot be restored afterwards.` : 'It cannot be restored afterwards.',
    action: 'Delete for good', run: () => { for (const item of group) actions.remove.mutate(item.id); },
  });

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {retentionSentence(retention)}
            {showSettingsLink && <> Change this in <Link to={settingsHref('bin')} className="underline underline-offset-4 hover:text-foreground">Settings › Bin</Link>.</>}
          </p>
          {deletePolicy.lock && <PolicyNote reason={deletePolicy.lock} />}
        </div>
        <Button variant="outline" size="sm" className="shrink-0 text-destructive hover:text-destructive" onClick={confirmEmpty}
          disabled={!!deletePolicy.lock || binItems.length === 0 || actions.empty.isPending}>Empty bin</Button>
      </div>
      {groups.length === 0 ? (
        <EmptyState icon={Trash2} title="The bin is empty" description={module ? `Deleted ${moduleLabel(module).toLowerCase()} items wait here before they are gone for good.` : 'Deleted contacts, events, tasks and recordings wait here before they are gone for good.'} />
      ) : (
        <ul ref={list} tabIndex={-1} aria-label="Deleted items" className="-mx-2 divide-y divide-border outline-none">
          {groups.map(group => {
            const lead = group[0];
            const Icon = ICONS[lead.item_type];
            const name = lead.title || `Untitled ${KINDS[lead.item_type]}`;
            const ids = group.map(item => item.id);
            return (
              <li key={lead.group_id ?? lead.id} className="flex items-start gap-3 px-2 py-3">
                <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">
                    {name}
                    {!module && <span className="font-normal text-muted-foreground"> · {moduleLabel(lead.module)}</span>}
                  </p>
                  {itemMeta(lead, group).map(line => <p key={line} className="text-xs text-muted-foreground">{line}</p>)}
                </div>
                <div className="flex shrink-0 items-center gap-1 touch:gap-3">
                  <Button variant="outline" size="sm" aria-label={`Restore ${name}`} disabled={actions.restore.isPending}
                    onClick={event => { opener.current = event.currentTarget; actions.restore.mutate({ ids, modules: [...new Set(group.map(item => item.module))] }); }}>Restore</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`More actions for ${name}`}><MoreHorizontal aria-hidden="true" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <PolicyMenuItem lock={deletePolicy.lock} className="text-destructive focus:text-destructive" onClick={() => confirmDelete(group)}>Delete for good</PolicyMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <DestinationDialog ask={shownAsk} titles={askedTitles} pending={actions.restore.isPending} onClose={() => setAsk(null)} returnFocus={returnFocus}
        onChoose={calendarId => {
          // Only the items still in the bin at this moment are sent.
          const ids = shownAsk ? shownAsk.ids.filter(id => binItems.some(item => item.id === id)) : [];
          if (ids.length) actions.restore.mutate({ ids, modules: shownAsk?.modules, calendarId });
          setAsk(null);
        }} />

      <AlertDialog open={!!confirm} onOpenChange={open => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => confirm?.run()}>{confirm?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
