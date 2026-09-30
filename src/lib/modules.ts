export type ModuleId = 'mail' | 'calendar' | 'contacts' | 'recordings' | 'games' | 'notes';
export type ModulePreference = { id: ModuleId; label: string; visible: boolean; enabled: boolean; background: boolean; backgroundSupported?: boolean };
const routeModules: Record<string, ModuleId> = { mail: 'mail', calendar: 'calendar', todo: 'calendar', contacts: 'contacts', recordings: 'recordings', music: 'recordings', games: 'games', notes: 'notes' };
export const moduleForPath = (path: string) => routeModules[path.split('?')[0].split('/')[1]];
// Old device snapshots predate module settings; preserve their existing read-only behavior.
export const legacyOfflineModules: ModulePreference[] = Object.entries({ mail: 'Mail', calendar: 'Calendar and ToDo', contacts: 'Contacts', recordings: 'Recordings', games: 'Games', notes: 'Notes' }).map(([id, label]) => ({ id: id as ModuleId, label, visible: true, enabled: true, background: true, backgroundSupported: id === 'mail' || id === 'calendar' }));
