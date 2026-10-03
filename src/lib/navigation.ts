import { Calendar, CheckSquare, Mail, Mic, Users, type LucideIcon } from 'lucide-react';
import type { ModuleId, ModulePreference } from '@/lib/modules';

export type ModulePage = { module: ModuleId; name: string; description: string; href: string; icon: LucideIcon };

// One entry per module page. Calendar and ToDo belong to the same module and stay together.
export const MODULE_PAGES: ModulePage[] = [
  { module: 'mail', name: 'Mail', description: 'Email accounts and folders', href: '/mail', icon: Mail },
  { module: 'calendar', name: 'Calendar', description: 'Events and calendars', href: '/calendar', icon: Calendar },
  { module: 'calendar', name: 'ToDo', description: 'Tasks and due dates', href: '/todo', icon: CheckSquare },
  { module: 'contacts', name: 'Contacts', description: 'People, phone numbers and email addresses', href: '/contacts', icon: Users },
  { module: 'recordings', name: 'Recordings', description: 'Audio recordings and transcripts', href: '/recordings', icon: Mic },
];

// The mobile bar has room for this many module pages next to More.
export const BOTTOM_NAV_PAGES = 4;

// Module pages in the user's saved module order (the API returns modules in that order).
export function orderedModulePages(modules: ModulePreference[], canNavigate: (href: string) => boolean): ModulePage[] {
  const rank = (id: ModuleId) => { const index = modules.findIndex(module => module.id === id); return index < 0 ? modules.length : index; };
  return MODULE_PAGES.filter(page => canNavigate(page.href))
    .map((page, index) => ({ page, index }))
    .sort((a, b) => rank(a.page.module) - rank(b.page.module) || a.index - b.index)
    .map(({ page }) => page);
}
