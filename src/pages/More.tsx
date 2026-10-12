import { Link } from 'react-router-dom';
import { ChevronRight, LogOut, Server, Settings, Users } from 'lucide-react';
import { useModules } from '@/hooks/use-modules';
import { useAuth } from '@/contexts/useAuth';
import { useAttentionItems } from '@/hooks/use-attention';
import { BOTTOM_NAV_PAGES, navigationPages } from '@/lib/navigation';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { AttentionList } from '@/components/layout/AttentionList';

const rowClass = 'flex items-center gap-3 px-1 py-3.5 text-[15px] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Phone: pages that do not fit in the bottom bar, decisions waiting, settings and sign out. */
const More = () => {
  const { pages, canNavigate } = useModules();
  const { user, signOut } = useAuth();
  const attention = useAttentionItems();
  const links = [
    // Pages that do not fit in the mobile bar, in the user's order.
    ...navigationPages(pages, canNavigate).slice(BOTTOM_NAV_PAGES).map(page => ({ title: page.name, href: page.href, icon: page.icon })),
    { title: 'Settings', href: '/settings', icon: Settings },
    ...(user?.role === 'admin' ? [
      { title: 'Server settings', href: '/admin/settings', icon: Server },
      { title: 'Users', href: '/admin/users', icon: Users },
    ] : []),
  ];

  return (
    <PageShell>
      <PageHeader title="More" />
      <PageBody width="reading">
        {attention.length > 0 && (
          <section aria-labelledby="more-attention" className="mb-6">
            <h2 id="more-attention" className="mb-1 text-sm font-medium text-muted-foreground">Needs your attention</h2>
            <AttentionList items={attention} />
          </section>
        )}
        <nav aria-label="More pages" className="divide-y divide-border border-y border-border">
          {links.filter(item => canNavigate(item.href)).map((item) => (
            <Link key={item.href} to={item.href} className={rowClass}>
              <item.icon aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
              <span className="flex-1">{item.title}</span>
              <ChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            </Link>
          ))}
        </nav>
        <div className="mt-8 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user?.full_name || 'Signed in'}</p>
            <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
          </div>
          <button type="button" onClick={signOut} className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <LogOut aria-hidden="true" className="h-4 w-4" />Sign out
          </button>
        </div>
      </PageBody>
    </PageShell>
  );
};

export default More;
