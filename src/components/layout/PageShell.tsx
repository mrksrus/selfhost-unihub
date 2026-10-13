import { useCallback, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { PanelContext, usePagePanel } from '@/components/layout/page-panel';
import { Link } from 'react-router-dom';
import { ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { emitAppEvent } from '@/lib/app-events';
import { NARROW_QUERY, useMediaQuery } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';

// The frame every page uses. Global navigation (rail or bottom bar) belongs to
// the app layout; everything here belongs to the page:
//
//   wide:    [context panel][header row / body]
//   narrow:  [header = top bar with scope button][body], panel opens as a sheet
//
// A page with scope (mail accounts and folders, task lists, settings sections)
// passes it as `panel`. New features add their own panel instead of a second
// sidebar inside the page.

interface PageShellProps {
  /** Scope for this page: lists, accounts, folders, sections. */
  panel?: ReactNode;
  /** Accessible name of the panel, e.g. "Accounts and folders". */
  panelLabel?: string;
  children: ReactNode;
}

export function PageShell({ panel, panelLabel = 'Page navigation', children }: PageShellProps) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const [sheetOpen, setSheetOpen] = useState(false);
  const collapsible = !!panel && narrow;
  const open = useCallback(() => setSheetOpen(true), []);
  const close = useCallback(() => setSheetOpen(false), []);
  const state = useMemo(() => ({ collapsible, isOpen: sheetOpen, open, close }), [collapsible, sheetOpen, open, close]);

  return (
    <PanelContext.Provider value={state}>
      <div className="flex h-full min-h-0 w-full">
        {panel && !narrow && (
          <aside aria-label={panelLabel} className="flex w-64 shrink-0 flex-col border-r border-border bg-card min-h-0">
            {panel}
          </aside>
        )}
        {collapsible && (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="left" aria-label={panelLabel}
              className="flex w-[85vw] max-w-xs flex-col gap-0 bg-card p-0 pt-[env(safe-area-inset-top,0px)]">
              <SheetTitle className="sr-only">{panelLabel}</SheetTitle>
              <SheetDescription className="sr-only">Choose what this page shows.</SheetDescription>
              {panel}
            </SheetContent>
          </Sheet>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </PanelContext.Provider>
  );
}

interface PageHeaderProps {
  title: ReactNode;
  /**
   * Where the page is looking ("All accounts", "Overdue"). On narrow windows it
   * becomes the button that opens the panel.
   */
  scope?: ReactNode;
  /** Buttons on the right. Keep to the page's own actions. */
  actions?: ReactNode;
  /** A second row: filters, search, tabs. */
  children?: ReactNode;
  /** A link back (e.g. from a reader), shown before the title. */
  back?: ReactNode;
  /** Hide the global search button on phones (when the page has its own search first). */
  hideSearch?: boolean;
  className?: string;
}

/** Page title row. On phones it is the top bar. */
export function PageHeader({ title, scope, actions, children, back, hideSearch = false, className }: PageHeaderProps) {
  const panel = usePagePanel();
  return (
    <header className={cn('shrink-0 border-b border-border bg-background', className)}>
      <div className="flex h-14 min-w-0 items-center gap-2 px-4 md:px-6">
        {back}
        <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{title}</h1>
        {scope && (panel.collapsible ? (
          <button type="button" onClick={panel.open} aria-haspopup="dialog" aria-expanded={panel.isOpen}
            className="inline-flex h-8 min-w-0 max-w-[50%] shrink items-center gap-1 rounded-full bg-muted px-3 touch:h-10 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="truncate">{scope}</span>
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </button>
        ) : <span className="min-w-0 truncate text-sm text-muted-foreground">{scope}</span>)}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!hideSearch && (
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Search"
              onClick={() => emitAppEvent('unihub:open-search')}>
              <Search aria-hidden="true" />
            </Button>
          )}
          {actions}
        </div>
      </div>
      {children}
    </header>
  );
}

const widths = {
  /** Text and forms: settings, a single list. */
  reading: 'max-w-3xl',
  /** Lists with columns, dashboards. */
  wide: 'max-w-6xl',
  full: 'max-w-none',
} as const;

/** The scrolling area below the header. Leaves room for the phone bottom bar. */
export function PageBody({ children, width = 'wide', className, padded = true }: {
  children: ReactNode; width?: keyof typeof widths; className?: string; padded?: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-mobile-nav md:pb-0">
      <div className={cn('w-full', widths[width], padded && 'px-4 py-5 md:px-6 md:py-6', className)}>{children}</div>
    </div>
  );
}

/** Shows its content only while the panel is a sheet: for header copies of actions the panel already offers. */
export function NarrowOnly({ children }: { children: ReactNode }) {
  return usePagePanel().collapsible ? <>{children}</> : null;
}

/** The top row of a context panel: its name and one main action. Leaves room for the sheet's close button. */
export function PanelHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  const panel = usePagePanel();
  return (
    <div className={cn('flex h-14 shrink-0 items-center justify-between gap-2 px-4', panel.collapsible && 'pr-12')}>
      <h2 className="truncate text-base font-semibold">{title}</h2>
      {action}
    </div>
  );
}

/** A group of panel entries with an optional small heading. */
export function PanelGroup({ label, action, children, className }: { label?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('px-2 py-2', className)}>
      {(label || action) && (
        <div className="flex min-h-7 items-center justify-between gap-2 px-2 pb-1">
          {label && <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>}
          {action}
        </div>
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

type IconType = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

interface PanelItemProps {
  children: ReactNode;
  active?: boolean;
  icon?: IconType;
  /** A small colored dot instead of an icon (calendar colors). */
  color?: string;
  count?: number | null;
  /** Count shown in the warning color (overdue). */
  countTone?: 'default' | 'warning';
  /** What the count means, read after the name, e.g. "unread". */
  countLabel?: string;
  /** Second line, e.g. the address under an account name. */
  description?: ReactNode;
  href?: string;
  onSelect?: () => void;
  /** Extra controls shown on hover or focus (edit, remove). */
  trailing?: ReactNode;
  title?: string;
}

/** One entry in a context panel: a folder, a list, a section. */
export function PanelItem({ children, active = false, icon: Icon, color, count, countTone = 'default', countLabel, description, href, onSelect, trailing, title }: PanelItemProps) {
  const panel = usePagePanel();
  const className = cn(
    'flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm touch:py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
  );
  const content = <>
    {Icon && <Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', active && 'text-accent')} />}
    {color && <span aria-hidden="true" className="mx-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
    <span className="min-w-0 flex-1">
      <span className="block truncate">{children}</span>
      {description && ' '}
      {description && <span className={cn('block text-xs text-muted-foreground', typeof description === 'string' && 'truncate')}>{description}</span>}
    </span>

    {count ? <>
      <span aria-hidden="true" className={cn('shrink-0 text-xs tabular-nums', countTone === 'warning' ? 'text-warning' : active ? 'text-accent' : 'text-muted-foreground')}>{count}</span>
      {countLabel && <span className="sr-only">, {count} {countLabel}</span>}
    </> : null}
  </>;
  const select = () => { onSelect?.(); panel.close(); };
  const item = href
    ? <Link to={href} className={className} aria-current={active ? 'page' : undefined} title={title} onClick={select}>{content}</Link>
    : <button type="button" className={className} aria-current={active ? 'page' : undefined} title={title} onClick={select}>{content}</button>;

  if (!trailing) return item;
  return (
    <div className="group relative">
      {item}
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        {trailing}
      </div>
    </div>
  );
}
