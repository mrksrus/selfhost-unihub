// Built-in modules only. Recovery deliberately uses its own complete data catalog.
const MODULE_CATALOG = Object.freeze([
  { id: 'mail', label: 'Mail', backgroundSupported: true },
  { id: 'calendar', label: 'Calendar and ToDo', backgroundSupported: true },
  { id: 'contacts', label: 'Contacts', backgroundSupported: false },
  { id: 'recordings', label: 'Recordings and Music', backgroundSupported: false },
].map(module => Object.freeze({ ...module, recoverySection: module.id, visible: true, enabled: true, background: true })));

// Pages in the navigation. A module can have several pages; they are shown,
// hidden and ordered one by one, but enabling a module still enables all of
// them. Today belongs to no module.
const PAGE_CATALOG = Object.freeze([
  { id: 'mail', label: 'Mail', module: 'mail' },
  { id: 'calendar', label: 'Calendar', module: 'calendar' },
  { id: 'todo', label: 'ToDo', module: 'calendar' },
  { id: 'contacts', label: 'Contacts', module: 'contacts' },
  { id: 'recordings', label: 'Recordings', module: 'recordings' },
  { id: 'music', label: 'Music', module: 'recordings' },
  { id: 'today', label: 'Today', module: null },
].map(page => Object.freeze(page)));

// Removed modules whose choices may still be stored in user_settings or backups.
// They are ignored when read and rejected in new updates.
const RETIRED_MODULE_IDS = Object.freeze(['games', 'notes']);

// A module's API lives under /api/<module id>. Route files not yet declared
// with specs derive their module gate from this; a route elsewhere that touches
// a module (the /api/settings/clear-* actions) declares `module` on its spec.
const MODULE_IDS = MODULE_CATALOG.map(module => module.id);
const MODULE_PATH_PATTERN = new RegExp(`^/api/(${MODULE_IDS.join('|')})(?:/|$)`);

function getModuleForPath(pathname: string) {
  const match = MODULE_PATH_PATTERN.exec(pathname);
  return match ? match[1] : null;
}
export { MODULE_CATALOG, PAGE_CATALOG, RETIRED_MODULE_IDS, getModuleForPath };
