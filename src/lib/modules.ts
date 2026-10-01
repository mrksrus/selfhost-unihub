export type ModuleId = 'mail' | 'calendar' | 'contacts' | 'recordings' | 'notes';
export type ModulePreference = { id: ModuleId; label: string; visible: boolean; enabled: boolean; background: boolean; backgroundSupported?: boolean };
const routeModules: Record<string, ModuleId> = { mail: 'mail', calendar: 'calendar', todo: 'calendar', contacts: 'contacts', recordings: 'recordings', music: 'recordings', notes: 'notes' };
const moduleIds = new Set<string>(Object.values(routeModules));
// Snapshots saved before a module was removed (for example Games in 0.12.0) may still list it.
export const knownModules = (modules: ModulePreference[]) => modules.filter(module => moduleIds.has(module.id));
export const moduleForPath = (path: string) => routeModules[path.split('?')[0].split('/')[1]];
// Old device snapshots predate module settings; preserve their existing read-only behavior.
export const legacyOfflineModules: ModulePreference[] = Object.entries({ mail: 'Mail', calendar: 'Calendar and ToDo', contacts: 'Contacts', recordings: 'Recordings', notes: 'Notes' }).map(([id, label]) => ({ id: id as ModuleId, label, visible: true, enabled: true, background: true, backgroundSupported: id === 'mail' || id === 'calendar' }));
