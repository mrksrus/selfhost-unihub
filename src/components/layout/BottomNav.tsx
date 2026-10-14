import { useModules } from '@/hooks/use-modules';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { MoreHorizontal } from 'lucide-react';
import { BOTTOM_NAV_PAGES, navigationPages, pageLink } from '@/lib/navigation';
import { useAttentionItems } from '@/hooks/use-attention';
import { useNavigationCounts } from '@/hooks/use-navigation-counts';

const MORE_PATHS = ['/more', '/settings', '/admin'];

/** Phone navigation: the first pages in the user's order, then More. */
const BottomNav = () => {
  const { pages, canNavigate } = useModules();
  const location = useLocation();
  const attention = useAttentionItems();
  const counts = useNavigationCounts();
  // The first pages in the user's order; the rest are listed on More, which
  // is also marked for hidden pages opened by link and for Settings.
  const shown = navigationPages(pages, canNavigate).slice(0, BOTTOM_NAV_PAGES);
  const navItems = [...shown, { id: 'more' as const, name: 'More', href: '/more', icon: MoreHorizontal }];
  const moreHrefs = [...MORE_PATHS, ...pages.map((page) => pageLink(page.id).href).filter((href) => !shown.some((page) => page.href === href))];

  return (
    <nav
      aria-label="Main"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 grid auto-cols-fr grid-flow-col border-t border-border bg-card/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
    >
      {navItems.map((item) => {
        const isActive =
          item.href === '/more'
            ? moreHrefs.some((path) => location.pathname.startsWith(path))
            : location.pathname.startsWith(item.href);
        const count = item.id === 'more' ? 0 : counts[item.id] ?? 0;
        const dot = item.id === 'more' && attention.length > 0;
        return (
          <NavLink
            key={item.id}
            to={item.href}
            aria-label={dot ? `${item.name}, ${attention.length} ${attention.length === 1 ? 'item needs' : 'items need'} attention` : count ? `${item.name}, ${count} unread` : undefined}
            className={cn(
              'relative flex min-w-0 flex-col items-center justify-center gap-1 px-1 pb-2 pt-2.5 text-[11px] font-medium touch:gap-0.5 transition-colors',
              'text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              isActive && 'text-accent'
            )}
          >
            <item.icon aria-hidden="true" className="h-6 w-6 shrink-0 touch:h-7 touch:w-7" />
            <span className="max-w-full truncate">{item.name}</span>
            {count > 0 && <span aria-hidden="true" className="absolute left-1/2 top-1 ml-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-accent-foreground">{count > 99 ? '99+' : count}</span>}
            {dot && <span aria-hidden="true" className="absolute left-1/2 top-2 ml-2 h-2 w-2 rounded-full bg-warning ring-2 ring-card" />}
          </NavLink>
        );
      })}
    </nav>
  );
};

export default BottomNav;
