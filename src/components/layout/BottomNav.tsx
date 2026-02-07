import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { LayoutDashboard, Users, Calendar, Mail } from 'lucide-react';

const navItems = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Contacts', href: '/contacts', icon: Users },
  { name: 'Calendar', href: '/calendar', icon: Calendar },
  { name: 'Mail', href: '/mail', icon: Mail },
];

const BottomNav = () => {
  const location = useLocation();

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around bg-card border-t border-border shadow-lg"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
    >
      {navItems.map((item) => {
        const isActive =
          item.href === '/'
            ? location.pathname === '/'
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
