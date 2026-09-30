import { useRef } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import type { MailAccount, MailWriteback } from '@/lib/mail-api';
import type { MailSyncJob } from '@/hooks/use-mail-sync-jobs';
import { groupWritebacks } from '@/hooks/use-mail-writebacks';
import { useUpdateModule, type ModulePreference } from '@/hooks/use-modules';
import { isOfflineMode } from '@/lib/offline';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { MailPendingChanges } from '@/components/mail/MailPendingChanges';

/** Which part of the sync panel receives focus when it opens. */
export type SyncPanelFocus = 'default' | 'cancel' | 'attention';

const activeJob = (job?: MailSyncJob) => job?.state === 'queued' || job?.state === 'running';
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const ago = (value: string | null | undefined) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? formatDistanceToNowStrict(date, { addSuffix: true }) : null;
};

function accountStatus(account: MailAccount, job: MailSyncJob | undefined): { text: string; coverage: string | null; error: boolean } {
  const progress = job && job.total !== null ? `${job.processed} of ${job.total}` : job?.processed ? `${job.processed} processed` : null;
  const coverage = job?.coverage && (job.coverage.history?.complete !== true || job.coverage.bodies?.complete !== true ||
    job.coverage.recent?.current !== true || job.coverage.flags?.complete === false) ? [
    job.coverage.recent?.current === true && 'Inbox current',
    job.coverage.history && job.coverage.history.complete !== true && 'Older mail not fully covered',
    job.coverage.bodies && job.coverage.bodies.complete !== true && 'Bodies still downloading',
    job.coverage.flags && job.coverage.flags.complete !== true && 'Flag coverage pending',
  ].filter(Boolean).join(' · ') || null : null;
  const join = (...parts: (string | null | false | undefined)[]) => parts.filter(Boolean).join(' · ');
  const last = ago(account.last_synced_at ?? job?.updated_at);
  switch (job?.state) {
    case 'queued': return { text: job.cancellation_requested ? 'Cancelling…' : join('Queued', job.phase, progress), coverage, error: false };
    case 'running': return { text: job.cancellation_requested ? join('Syncing', job.phase, 'Cancelling at the next safe point')
      : join('Syncing', job.phase, progress), coverage, error: false };
    case 'paused': return { text: join('Waiting', job.error || 'provider or credentials needed'), coverage, error: false };
    case 'error': return { text: join('Sync failed', job.error || 'check the account and try again'), coverage, error: true };
    case 'cancelled': return { text: join('Sync cancelled', last && `last sync ${last}`), coverage, error: false };
    default: {
      const current = job?.coverage?.recent?.current === true && job.coverage.history?.complete === true;
      return { text: current ? join('Up to date', last) : last ? `Not syncing · last sync ${last}` : 'Not synced yet', coverage, error: false };
    }
  }
}

function BackgroundSyncSwitch() {
  // MailPage always renders under ModuleGuard, which loads module preferences.
  // Observe that cache without a second fetcher or a dependency on auth here.
  const modules = useQuery<ModulePreference[]>({ queryKey: ['modules'], queryFn: skipToken });
  const update = useUpdateModule();
  const mail = modules.data?.find(module => module.id === 'mail');
  if (!mail || mail.backgroundSupported === false) return null;
  return <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
    <div className="min-w-0 space-y-0.5">
      <label htmlFor="mail-background-sync" className="text-sm font-medium">
        Background sync
      </label>
      <p id="mail-background-sync-hint" className="text-xs text-muted-foreground">
        {mail.background ? 'On. UniHub checks your accounts on its own. Turn it off to pause; your own actions still go through.'
          : 'Paused. UniHub won’t sync on its own. Sync now, reading, starring and moving still go through.'}
      </p>
      {update.error && <p role="alert" className="text-xs text-destructive">{update.error.message}</p>}
    </div>
    <Switch id="mail-background-sync" aria-describedby="mail-background-sync-hint" checked={mail.background}
      disabled={update.isPending || isOfflineMode()}
      onCheckedChange={value => update.mutate({ id: 'mail', patch: { background: value } })} />
  </div>;
}

interface ControlProps {
  accounts: MailAccount[];
  /** Accounts shown in the list: the selected one, or every active account in combined views. */
  viewAccountIds: string[];
  jobs: MailSyncJob[];
  jobsError: boolean;
  operations: MailWriteback[];
  operationsError: boolean;
  syncing: Set<string>;
  cancelling: Set<string>;
  onSync: (accountId: string) => void;
  onCancel: (accountId: string) => void;
  panel: SyncPanelFocus | null;
  onPanelChange: (focus: SyncPanelFocus | null) => void;
  touch: boolean;
}

function PanelBody({ accounts, jobs, jobsError, operations, operationsError, syncing, cancelling, onSync, onCancel, panel, viewAccountIds }: ControlProps) {
  const offline = isOfflineMode();
  const firstCancel = accounts.find(account => viewAccountIds.includes(account.id) && activeJob(jobs.find(job => job.account_id === account.id)))?.id
    ?? accounts.find(account => activeJob(jobs.find(job => job.account_id === account.id)))?.id;
  return <div className="space-y-4">
    {offline && <p className="text-xs text-muted-foreground">You are offline. Sync status and actions return when you reconnect.</p>}
    {jobsError && <p role="alert" className="text-xs">Mail sync status is unavailable. An accepted sync may still be running.</p>}
    <section aria-label="Accounts">
      <ul className="divide-y divide-border">
        {accounts.map(account => {
          const job = jobs.find(item => item.account_id === account.id);
          const status = accountStatus(account, job);
          const requested = cancelling.has(account.id) || job?.cancellation_requested === true;
          return <li key={account.id} className="flex items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={account.email_address}>{account.email_address}</p>
              <p className={cn('break-words text-xs', status.error ? 'text-destructive' : 'text-muted-foreground')}>
                {account.is_active ? status.text : 'Not connected'}
              </p>
              {status.coverage && <p className="break-words text-xs text-muted-foreground">{status.coverage}</p>}
            </div>
            {activeJob(job) ? <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs"
              data-autofocus={panel === 'cancel' && account.id === firstCancel ? '' : undefined}
              disabled={requested || offline} onClick={() => onCancel(account.id)}
              aria-label={`Cancel sync for ${account.email_address}`}>
              {requested ? 'Cancelling…' : 'Cancel'}
            </Button> : account.is_active && <Button size="sm" variant="ghost" className="h-8 shrink-0 text-xs"
              disabled={syncing.has(account.id) || offline} onClick={() => onSync(account.id)}
              aria-label={`Sync ${account.email_address} now`}>
              {syncing.has(account.id) ? 'Requesting…' : 'Sync now'}
            </Button>}
          </li>;
        })}
      </ul>
    </section>
    {!offline && <section aria-label="Server changes">
      <MailPendingChanges operations={operations} unavailable={operationsError} focusAttention={panel === 'attention'} />
    </section>}
    <BackgroundSyncSwitch />
  </div>;
}

/**
 * The toolbar sync button. Idle, one click requests a sync. While a sync runs
 * or changes wait, the click opens the sync panel instead, so a single tap
 * never cancels anything. The chevron always opens the panel.
 */
export function MailSyncControl(props: ControlProps) {
  const { accounts, viewAccountIds, jobs, jobsError, operations, operationsError, syncing, onSync, panel, onPanelChange, touch } = props;
  const contentRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const modules = useQuery<ModulePreference[]>({ queryKey: ['modules'], queryFn: skipToken });
  const paused = modules.data?.find(module => module.id === 'mail')?.background === false;
  const targets = accounts.filter(account => account.is_active && viewAccountIds.includes(account.id)).map(account => account.id);
  const running = jobs.some(job => viewAccountIds.includes(job.account_id) && activeJob(job));
  const requesting = targets.some(id => syncing.has(id));
  const failed = jobs.some(job => viewAccountIds.includes(job.account_id) && job.state === 'error');
  const { waiting, attention } = groupWritebacks(operations);
  const warn = attention.length > 0 || failed || jobsError || operationsError;
  const idle = !running && !waiting.length && !warn;

  const details = [
    waiting.length > 0 && `${plural(waiting.length, 'change', 'changes')} waiting`,
    attention.length > 0 && `${plural(attention.length, 'change needs', 'changes need')} attention`,
    failed && 'sync failed',
    (jobsError || operationsError) && 'status unavailable',
    paused && 'background sync paused',
  ].filter(Boolean);
  const label = `${running ? 'Syncing' : requesting ? 'Requesting mail sync' : 'Sync mail'}${details.length ? ` — ${details.join(', ')}` : ''}${idle ? '' : ' — open sync details'}`;
  const badge = waiting.length > 99 ? '99+' : String(waiting.length);
  const open = panel !== null;

  const activate = () => {
    if (idle) targets.forEach(id => onSync(id));
    else onPanelChange(running ? 'cancel' : attention.length ? 'attention' : 'default');
  };
  const focusRequested = (event: Event) => {
    const target = contentRef.current?.querySelector<HTMLElement>('[data-autofocus]');
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.scrollIntoView?.({ block: 'nearest' });
  };
  // Without a Radix trigger, return focus to the sync button explicitly.
  const focusButton = (event: Event) => { event.preventDefault(); buttonRef.current?.focus(); };
  const title = 'Mail sync';

  const trigger = <div ref={anchorRef} className="flex items-center">
    <Button ref={buttonRef} variant="ghost" size="icon" className="group relative" onClick={activate}
      disabled={idle && (requesting || targets.length === 0)} title={label} aria-label={label}
      aria-haspopup={idle ? undefined : 'dialog'} aria-expanded={idle ? undefined : open}>
      {running || requesting ? <>
        <span aria-hidden="true" className={cn('block h-[18px] w-[18px] rounded-full border-2 border-current border-r-transparent text-accent motion-safe:animate-spin group-hover:text-current',
          !touch && running && 'group-hover:hidden group-focus-visible:hidden')} />
        {!touch && running && <X aria-hidden="true" className="hidden group-hover:block group-focus-visible:block" />}
      </> : <RefreshCw aria-hidden="true" className={cn(paused && 'opacity-60')} />}
      {paused && idle && <span aria-hidden="true" className="absolute bottom-2 right-2 flex gap-[2px]">
        <span className="h-2 w-[2px] rounded-full bg-current" /><span className="h-2 w-[2px] rounded-full bg-current" />
      </span>}
      {waiting.length > 0 && <span aria-hidden="true" data-testid="mail-sync-badge"
        className="absolute right-0 top-0.5 h-4 min-w-4 rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 tabular-nums text-accent-foreground ring-2 ring-background">
        {badge}
      </span>}
      {warn && <span aria-hidden="true" data-testid="mail-sync-warning"
        className="absolute bottom-1.5 right-1.5 h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-background" />}
    </Button>
    <Button variant="ghost" size="icon" className={cn('h-10', touch ? 'w-9' : 'w-7')} aria-label="Sync details" title="Sync details"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => onPanelChange(open ? null : 'default')}>
      <ChevronDown aria-hidden="true" />
    </Button>
  </div>;

  if (touch) return <>
    {trigger}
    <Sheet open={open} onOpenChange={next => onPanelChange(next ? 'default' : null)}>
      <SheetContent side="bottom" ref={contentRef} onOpenAutoFocus={focusRequested} onCloseAutoFocus={focusButton}
        className="max-h-[85dvh] overflow-y-auto rounded-t-lg p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
        <SheetTitle className="mb-1 pr-8 text-base">{title}</SheetTitle>
        <SheetDescription className="sr-only">Sync state of each account and changes waiting for the server.</SheetDescription>
        <PanelBody {...props} />
      </SheetContent>
    </Sheet>
  </>;
  return <Popover open={open} onOpenChange={next => onPanelChange(next ? 'default' : null)}>
    <PopoverAnchor asChild>{trigger}</PopoverAnchor>
    <PopoverContent ref={contentRef} align="end" aria-labelledby="mail-sync-panel-title" onOpenAutoFocus={focusRequested}
      onCloseAutoFocus={focusButton}
      // The toolbar buttons toggle the panel themselves; do not close it on their pointerdown first.
      onInteractOutside={event => { if (anchorRef.current?.contains(event.target as Node)) event.preventDefault(); }}
      className="max-h-[min(70vh,36rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto">
      <h2 id="mail-sync-panel-title" className="mb-2 text-sm font-semibold">{title}</h2>
      <PanelBody {...props} />
    </PopoverContent>
  </Popover>;
}

/** The only inline sync element: shown while a change needs the user's decision. */
export function MailSyncAttentionLine({ operations, onReview }: { operations: MailWriteback[]; onReview: () => void }) {
  const count = groupWritebacks(operations).attention.length;
  if (!count || isOfflineMode()) return null;
  return <div role="status" className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs sm:px-4">
    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-warning" />
    <span className="truncate">{plural(count, 'change needs', 'changes need')} your attention</span>
    <span aria-hidden="true" className="text-muted-foreground">·</span>
    <Button variant="link" size="sm" className="h-auto shrink-0 p-0 text-xs" onClick={onReview}>Review</Button>
  </div>;
}
