import { useContext, useEffect, useId, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarDays, CalendarRange, CheckCircle2, CloudOff, Loader2, Mic, MoreHorizontal, Trash2, UserRound } from 'lucide-react';
import { AuthContext } from '@/contexts/auth-context';
import { usePolicy } from '@/hooks/use-policies';
import { useToast } from '@/hooks/use-toast';
import { hasCode } from '@/lib/api-error';
import { useBinActions, type DestinationAsk } from '@/hooks/use-bin-actions';
import { BIN_MODULES, binQueryKeys, binQueryOptions, groupBinItems, retentionSentence, type BinItem, type BinModule } from '@/lib/bin-api';
import { calendarApi, calendarQueryKeys, type CalendarCalendar } from '@/lib/calendar-api';
import { listRefusal } from '@/lib/tasks';
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
/** One id per group (a group restores as a unit), in the order given. */
function oneOfEachGroup(items: readonly BinItem[]) {
  return [...new Map(items.map(item => [item.group_id ?? item.id, item.id])).values()];
}

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
  /** Where focus goes when the dialog closes: after a submission the view, after a plain cancel the control that opened it. */
  returnFocus: (reason: 'submitted' | 'dismissed') => void;
}) {
  const submitted = useRef(false);
  const id = useId();
  const [chosen, setChosen] = useState('');
  const open = !!ask;
  // A choice belongs to one ask: another ask, or none, starts without one. (The dialog stays
  // mounted, so closing it from outside runs no onOpenChange.)
  const askKey = ask ? `${ask.kind}:${ask.ids.join(',')}` : '';
  useEffect(() => { setChosen(''); }, [askKey]);
  const calendars = useQuery({ queryKey: calendarQueryKeys.calendars, queryFn: ({ signal }) => calendarApi.fetchCalendars(signal), enabled: open });
  const unavailable = Object.fromEntries((calendars.data ?? []).flatMap(calendar => { const why = ask && wrongKind(calendar, ask.kind); return why ? [[calendar.id, why]] : []; }));
  // Only a calendar that is listed and can take the items is sent, whatever the state says.
  const chosenCalendar = calendars.data?.find(calendar => calendar.id === chosen);
  const eligible = !!chosenCalendar && !unavailable[chosenCalendar.id] && !listRefusal(chosenCalendar, { undated: false });
  const what = titles.length === 1 ? titles[0] : `${titles.length} items`;
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !pending) { setChosen(''); onClose(); } }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); returnFocus(submitted.current ? 'submitted' : 'dismissed'); submitted.current = false; }}>
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
          <Button type="button" disabled={!eligible || pending} onClick={() => { if (eligible) { submitted.current = true; onChoose(chosen); } setChosen(''); }}>
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
 * connection. The server answers a page at a time (whole groups, newest
 * first); "Show older items" at the end of the list appends the next page.
 */
export function BinView({ module, showSettingsLink = true }: { module?: BinModule; showSettingsLink?: boolean }) {
  const isOffline = !!useContext(AuthContext)?.isOffline;
  const client = useQueryClient();
  const { toast } = useToast();
  const query = useInfiniteQuery({ ...binQueryOptions(module), enabled: !isOffline });
  // A cursor the server no longer accepts (400 BIN_INVALID): the bin is read again from the newest items, with the server's word.
  const invalidCursor = hasCode(query.error, 'BIN_INVALID') ? query.error : null;
  useEffect(() => {
    if (!invalidCursor) return;
    toast({ title: 'Could not load older items', description: invalidCursor.message, variant: 'destructive' });
    void client.resetQueries({ queryKey: binQueryKeys.list(module), exact: true });
  }, [invalidCursor, client, module, toast]);
  const [ask, setAsk] = useState<DestinationAsk | null>(null);
  const actions = useBinActions(module, { onDestinationAsked: setAsk });
  const deletePolicy = usePolicy('bin.delete');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // Where focus returns when the destination dialog closes. After a submission the row is about to
  // change or go (a fast answer re-enables its Restore before the refetched list drops it), so focus
  // goes to the view itself, which is always there, and stays until the list has settled. After a
  // plain cancel it returns to the Restore button that opened the dialog while it is there and
  // enabled, else to an enabled Restore button of a row (never a row's menu), else to the view.
  const opener = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const view = useRef<HTMLDivElement | null>(null);
  const returnFocus = (reason: 'submitted' | 'dismissed') => {
    const usable = (element: HTMLElement | null | undefined) => !!element && element.isConnected && !(element as HTMLButtonElement).disabled;
    const target = reason === 'submitted' ? view.current
      : usable(opener.current) ? opener.current : list.current?.querySelector<HTMLElement>('button[data-bin-restore]:not(:disabled)') ?? view.current;
    target?.focus();
  };
  // An ask names only items still in the bin: one restored or deleted elsewhere since (a refetch
  // dropped it) is left out, and an ask with nothing left closes.
  const items = query.data?.pages.flatMap(page => page.items);
  const liveAsk = ask && items ? { ...ask, ids: ask.ids.filter(id => items.some(item => item.id === id)) } : ask;
  const askEmpty = !!liveAsk && liveAsk.ids.length === 0;
  useEffect(() => { if (askEmpty) setAsk(null); }, [askEmpty]);

  if (isOffline) return <EmptyState icon={CloudOff} title="The bin needs a connection" description="Deleted items are kept on the server, not in the offline copy." />;
  if (query.isLoading) return <LoadingState label="Loading the bin…" />;
  // An older page that failed leaves the loaded pages in place (its row says so below).
  if (query.error && !query.isFetchNextPageError) return <ErrorState title="Could not load the bin" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  const binItems = items ?? [];
  const retention = query.data!.pages[0].retention;
  const groups = groupBinItems(binItems);
  const shownAsk = liveAsk && liveAsk.ids.length > 0 ? liveAsk : null;
  const askedTitles = shownAsk ? shownAsk.ids.map(id => { const item = binItems.find(entry => entry.id === id); return item?.title || `an ${KINDS[item?.item_type ?? 'event']}`; }) : [];
  const moduleLabel = (id: BinModule) => BIN_MODULES.find(entry => entry.id === id)?.label ?? id;

  const confirmEmpty = () => setConfirm({
    title: module ? `Empty the ${moduleLabel(module).toLowerCase()} bin?` : 'Empty the bin?',
    description: query.hasNextPage ? 'Everything in it, also the older items not shown yet, is deleted for good. Nothing can be restored afterwards.'
      : `${plural(binItems.length, 'item')} ${binItems.length === 1 ? 'is' : 'are'} deleted for good. Nothing can be restored afterwards.`,
    action: 'Delete for good', run: () => actions.empty.mutate(module),
  });
  const confirmDelete = (group: BinItem[]) => setConfirm({
    title: `Delete ${group[0].title || `this ${KINDS[group[0].item_type]}`} for good?`,
    description: group.length > 1 ? `${plural(group.length, 'item')} are deleted for good and cannot be restored afterwards.` : 'It cannot be restored afterwards.',
    action: 'Delete for good', run: () => { for (const item of group) actions.remove.mutate(item.id); },
  });

  return (
    <div ref={view} tabIndex={-1} className="outline-none">
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
            // One member names its group: the server brings the whole group back
            // (bin.ts), and a list with hundreds of events stays under the
            // request's id limit.
            const ids = [lead.id];
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
                  <Button variant="outline" size="sm" aria-label={`Restore ${name}`} disabled={actions.restore.isPending} data-bin-restore=""
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
      {query.isFetchNextPageError && !invalidCursor && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-2 py-3 text-sm">
          <span className="text-destructive">Could not load older items. {query.error?.message}</span>
          <Button variant="outline" size="sm" onClick={() => void query.fetchNextPage({ cancelRefetch: false })} disabled={query.isFetching}>Try again</Button>
        </div>
      )}
      {/* Waits while the bin is being read again after a change (a restore, Undo, a delete): a next
          page must not cancel that refresh and extend the stale pages. */}
      {query.hasNextPage && !query.isFetchNextPageError && (
        <div className="flex justify-center border-t border-border px-2 py-3">
          <Button variant="outline" size="sm" onClick={() => void query.fetchNextPage({ cancelRefetch: false })} disabled={query.isFetching}>
            {query.isFetchingNextPage && <Loader2 aria-hidden="true" className="animate-spin" />}Show older items
          </Button>
        </div>
      )}

      <DestinationDialog ask={shownAsk} titles={askedTitles} pending={actions.restore.isPending} onClose={() => setAsk(null)} returnFocus={returnFocus}
        onChoose={calendarId => {
          // Only the items still in the bin at this moment are sent, one per group.
          const ids = shownAsk ? oneOfEachGroup(shownAsk.ids.map(id => binItems.find(item => item.id === id)).filter((item): item is BinItem => !!item)) : [];
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
