import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarDays, CalendarRange, CheckCircle2, CloudOff, Mic, MoreHorizontal, Trash2, UserRound } from 'lucide-react';
import { useContext } from 'react';
import { AuthContext } from '@/contexts/auth-context';
import { usePolicy } from '@/hooks/use-policies';
import { useBinActions } from '@/hooks/use-bin-actions';
import { BIN_MODULES, binQueryOptions, groupBinItems, retentionSentence, type BinItem, type BinModule } from '@/lib/bin-api';
import { Button } from '@/components/ui/button';
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
  const actions = useBinActions(module);
  const deletePolicy = usePolicy('bin.delete');
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  if (isOffline) return <EmptyState icon={CloudOff} title="The bin needs a connection" description="Deleted items are kept on the server, not in the offline copy." />;
  if (query.isLoading) return <LoadingState label="Loading the bin…" />;
  if (query.error) return <ErrorState title="Could not load the bin" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  const { items, retention } = query.data!;
  const groups = groupBinItems(items);
  const moduleLabel = (id: BinModule) => BIN_MODULES.find(entry => entry.id === id)?.label ?? id;

  const confirmEmpty = () => setConfirm({
    title: module ? `Empty the ${moduleLabel(module).toLowerCase()} bin?` : 'Empty the bin?',
    description: `${plural(items.length, 'item')} ${items.length === 1 ? 'is' : 'are'} deleted for good. Nothing can be restored afterwards.`,
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
          disabled={!!deletePolicy.lock || items.length === 0 || actions.empty.isPending}>Empty bin</Button>
      </div>
      {groups.length === 0 ? (
        <EmptyState icon={Trash2} title="The bin is empty" description={module ? `Deleted ${moduleLabel(module).toLowerCase()} items wait here before they are gone for good.` : 'Deleted contacts, events, tasks and recordings wait here before they are gone for good.'} />
      ) : (
        <ul aria-label="Deleted items" className="-mx-2 divide-y divide-border">
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
                    onClick={() => actions.restore.mutate({ ids, modules: [...new Set(group.map(item => item.module))] })}>Restore</Button>
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
