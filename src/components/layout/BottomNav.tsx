import { useModules } from '@/hooks/use-modules';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { MoreHorizontal } from 'lucide-react';
import { BOTTOM_NAV_PAGES, MODULE_PAGES, orderedModulePages } from '@/lib/navigation';

const BottomNav = () => {
  const { modules, canNavigate } = useModules();
  const location = useLocation();
  // The first module pages in the user's order; the rest are listed on More.
  const shown = orderedModulePages(modules, canNavigate).slice(0, BOTTOM_NAV_PAGES);
  const navItems = [...shown, { name: 'More', href: '/more', icon: MoreHorizontal }];
  const moreHrefs = ['/more', '/music', '/dashboard', ...MODULE_PAGES.filter((page) => !shown.includes(page)).map((page) => page.href)];

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around bg-card border-t border-border shadow-lg"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
    >
      {navItems.map((item) => {
        const isActive =
          item.href === '/more'
            ? moreHrefs.some((path) => location.pathname.startsWith(path))
            : location.pathname.startsWith(item.href);
        return (
          <NavLink
            key={item.name}
            to={item.href}
            className={cn(
              'flex flex-col items-center justify-center gap-1 py-3 px-4 min-w-[64px] flex-1 text-xs font-medium transition-colors',
              'text-muted-foreground hover:text-foreground',
              isActive && 'text-accent'
            )}
          >
            <item.icon className={cn('h-6 w-6 shrink-0', isActive && 'text-accent')} />
            <span className="truncate">{item.name}</span>
          </NavLink>
        );
      })}
    </nav>
  );
};

export default BottomNav;
