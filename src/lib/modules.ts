export type ModuleId = 'mail' | 'calendar' | 'contacts' | 'recordings';
export type ModulePreference = { id: ModuleId; label: string; visible: boolean; enabled: boolean; background: boolean; backgroundSupported?: boolean };
// Pages are shown, hidden and ordered one by one. Enabling stays per module, so
// Calendar and ToDo, or Recordings and Music, are still switched on together.
export type PageId = 'mail' | 'calendar' | 'todo' | 'contacts' | 'recordings' | 'music' | 'today';
export type PagePreference = { id: PageId; label: string; module: ModuleId | null; visible: boolean };
const routeModules: Record<string, ModuleId> = { mail: 'mail', calendar: 'calendar', todo: 'calendar', contacts: 'contacts', recordings: 'recordings', music: 'recordings' };
const routePages: Record<string, PageId> = { mail: 'mail', calendar: 'calendar', todo: 'todo', contacts: 'contacts', recordings: 'recordings', music: 'music', dashboard: 'today' };
const moduleIds = new Set<string>(Object.values(routeModules));
// Same as PAGE_CATALOG in api/src/services/module-catalog.js.
export const PAGE_CATALOG: Omit<PagePreference, 'visible'>[] = [
  { id: 'mail', label: 'Mail', module: 'mail' },
  { id: 'calendar', label: 'Calendar', module: 'calendar' },
  { id: 'todo', label: 'ToDo', module: 'calendar' },
  { id: 'contacts', label: 'Contacts', module: 'contacts' },
  { id: 'recordings', label: 'Recordings', module: 'recordings' },
  { id: 'music', label: 'Music', module: 'recordings' },
  { id: 'today', label: 'Today', module: null },
];
const pageIds = new Set<string>(PAGE_CATALOG.map(page => page.id));
// Snapshots saved before a module was removed (Games in 0.12.0, Notes in 0.14.0) may still list it.
export const knownModules = (modules: ModulePreference[]) => modules.filter(module => moduleIds.has(module.id));
export const moduleForPath = (path: string) => routeModules[path.split('?')[0].split('/')[1]];
export const pageForPath = (path: string) => routePages[path.split('?')[0].split('/')[1]];
// Pages as the server would report them before any page was set up: in module
// order, each following its module's "Show in navigation", Today last. Used for
// device snapshots saved before 0.17.4 and until the page list has loaded.
export function defaultPages(modules: ModulePreference[]): PagePreference[] {
  const known = knownModules(modules);
  const order = [...known.map(module => module.id), ...PAGE_CATALOG.map(page => page.module).filter((id): id is ModuleId => !!id)];
  const ranked = [...PAGE_CATALOG].sort((a, b) => (a.module ? order.indexOf(a.module) : order.length) - (b.module ? order.indexOf(b.module) : order.length));
  return ranked.map(page => ({ ...page, visible: page.module ? known.find(module => module.id === page.module)?.visible !== false : true }));
}
export const knownPages = (pages: PagePreference[]) => pages.filter(page => pageIds.has(page.id));
// Old device snapshots predate module settings; preserve their existing read-only behavior.
export const legacyOfflineModules: ModulePreference[] = Object.entries({ mail: 'Mail', calendar: 'Calendar and ToDo', contacts: 'Contacts', recordings: 'Recordings and Music' }).map(([id, label]) => ({ id: id as ModuleId, label, visible: true, enabled: true, background: true, backgroundSupported: id === 'mail' || id === 'calendar' }));
