import { Calendar, CheckSquare, LayoutDashboard, Mail, Mic, Music2, Users, type LucideIcon } from 'lucide-react';
import type { PageId, PagePreference } from '@/lib/modules';

export type NavigationPage = { id: PageId; name: string; href: string; icon: LucideIcon };

const PAGE_LINKS: Record<PageId, { href: string; icon: LucideIcon }> = {
  mail: { href: '/mail', icon: Mail },
  calendar: { href: '/calendar', icon: Calendar },
  todo: { href: '/todo', icon: CheckSquare },
  contacts: { href: '/contacts', icon: Users },
  recordings: { href: '/recordings', icon: Mic },
  music: { href: '/music', icon: Music2 },
  today: { href: '/dashboard', icon: LayoutDashboard },
};

export const pageLink = (id: PageId) => PAGE_LINKS[id];

// The mobile bar has room for this many pages next to More.
export const BOTTOM_NAV_PAGES = 4;

// Pages shown in navigation, in the user's saved page order (the API returns them in that order).
export function navigationPages(pages: PagePreference[], canNavigate: (href: string) => boolean): NavigationPage[] {
  return pages
    .filter(page => PAGE_LINKS[page.id])
    .map(page => ({ id: page.id, name: page.label, ...PAGE_LINKS[page.id] }))
    .filter(page => canNavigate(page.href));
}
