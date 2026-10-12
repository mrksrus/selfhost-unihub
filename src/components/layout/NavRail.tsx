import { useState, type ButtonHTMLAttributes, type ComponentType } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Bell, LogOut, Search, Settings } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useModules } from '@/hooks/use-modules';
import { useAttentionItems } from '@/hooks/use-attention';
import { useNavigationCounts } from '@/hooks/use-navigation-counts';
import { navigationPages } from '@/lib/navigation';
import { emitAppEvent } from '@/lib/app-events';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AttentionList } from '@/components/layout/AttentionList';

type IconType = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

const itemClass = (active: boolean) => cn(
  'relative flex w-[66px] flex-col items-center gap-1 rounded-lg px-0.5 pb-1.5 pt-2 text-[10.5px] font-medium leading-tight tracking-tight transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  active ? 'text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
);

function RailContent({ icon: Icon, label, active, count, dot }: { icon: IconType; label: string; active: boolean; count?: number; dot?: boolean }) {
  return <>
    {active && <span aria-hidden="true" className="absolute -left-[3px] bottom-2.5 top-2.5 w-[3px] rounded-full bg-accent" />}

    <Icon aria-hidden="true" className={cn('h-5 w-5', active && 'text-accent')} />
    <span className="max-w-full truncate">{label}</span>
    {!!count && <span aria-hidden="true" className="absolute right-2 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-accent-foreground">{count > 99 ? '99+' : count}</span>}
    {dot && <span aria-hidden="true" className="absolute right-4 top-2 h-2 w-2 rounded-full bg-warning ring-2 ring-card" />}
  </>;
}

function RailLink({ to, icon, label, active, count }: { to: string; icon: IconType; label: string; active: boolean; count?: number }) {
  return (
    <NavLink to={to} aria-label={count ? `${label}, ${count} unread` : label} aria-current={active ? 'page' : undefined} className={itemClass(active)}>
      <RailContent icon={icon} label={label} active={active} count={count} />
    </NavLink>
  );
}

function RailButton({ icon, label, dot, ...rest }: { icon: IconType; label: string; dot?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={itemClass(false)} {...rest}>

      <RailContent icon={icon} label={label} active={false} dot={dot} />
    </button>
  );
}

/** Desktop navigation: the places of the app. Each page brings its own panel for scope. */
export default function NavRail() {
  const { pages, canNavigate } = useModules();
  const { user, signOut } = useAuth();
  const location = useLocation();
  const attention = useAttentionItems();
  const counts = useNavigationCounts();
  const [trayOpen, setTrayOpen] = useState(false);
  const initials = user?.full_name?.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase() || user?.email?.[0]?.toUpperCase() || '?';

  return (
    <nav aria-label="Main" className="flex h-dvh w-[72px] shrink-0 flex-col items-center border-r border-border bg-card py-3">
      <div aria-hidden="true" className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-accent-foreground">U</div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto">
        {navigationPages(pages, canNavigate).map(page => (
          <RailLink key={page.id} to={page.href} icon={page.icon} label={page.name}
            active={location.pathname.startsWith(page.href)} count={counts[page.id]} />
        ))}
      </div>
      <div className="flex flex-col items-center gap-0.5 pt-2">
        <RailButton icon={Search} label="Search" title="Search (Ctrl K)" aria-keyshortcuts="Control+K" onClick={() => emitAppEvent('unihub:open-search')} />
        <Popover open={trayOpen} onOpenChange={setTrayOpen}>
          <PopoverTrigger asChild>
            <button type="button" className={itemClass(trayOpen)}
              aria-label={attention.length ? `Attention, ${attention.length} ${attention.length === 1 ? 'item' : 'items'}` : 'Attention'}>
              <RailContent icon={Bell} label="Attention" active={false} dot={attention.length > 0} />
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" align="end" className="max-h-[min(70vh,32rem)] w-80 overflow-y-auto">
            <h2 className="mb-1 text-sm font-semibold">Needs your attention</h2>
            <AttentionList items={attention} onNavigate={() => setTrayOpen(false)} />
          </PopoverContent>
        </Popover>
        {/* Server settings and users live inside Settings for admins. */}
        <RailLink to="/settings" icon={Settings} label="Settings" active={location.pathname === '/settings' || location.pathname.startsWith('/admin')} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Account" className="mt-1 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {user?.avatar_url ? <img src={user.avatar_url} alt="" className="h-full w-full rounded-full object-cover" /> : initials}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-60">
            <DropdownMenuLabel className="font-normal">
              <p className="truncate text-sm font-medium">{user?.full_name || 'Signed in'}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}><LogOut className="mr-2 h-4 w-4" />Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
