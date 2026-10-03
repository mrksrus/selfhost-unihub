import { useModules } from '@/hooks/use-modules';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/useAuth';
import { ChevronRight, LayoutDashboard, Music2, Settings, Shield } from 'lucide-react';
import { BOTTOM_NAV_PAGES, orderedModulePages } from '@/lib/navigation';

const More = () => {
  const { modules, canNavigate } = useModules();
  const { user } = useAuth();
  const links = [
    // Module pages that do not fit in the mobile bar, in the user's order.
    ...orderedModulePages(modules, canNavigate).slice(BOTTOM_NAV_PAGES).map(page => ({ title: page.name, href: page.href, icon: page.icon })),
    { title: 'Music', href: '/music', icon: Music2 },
    { title: 'Today', href: '/dashboard', icon: LayoutDashboard },
    { title: 'Settings', href: '/settings', icon: Settings },
  ];

  if (user?.role === 'admin') {
    links.push({ title: 'Admin Settings', href: '/admin/settings', icon: Shield });
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-foreground mb-6">More</h1>
      <nav className="divide-y rounded-md border bg-card">
        {links.filter(item => canNavigate(item.href)).map((item) => (
          <Link key={item.href} to={item.href} className="flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors">
            <item.icon className="h-5 w-5 text-accent" />
            <span className="flex-1 font-medium">{item.title}</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        ))}
      </nav>
    </div>
  );
};

export default More;
