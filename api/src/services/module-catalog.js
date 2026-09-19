// Built-in modules only. Recovery deliberately uses its own complete data catalog.
const MODULE_CATALOG = Object.freeze([
  { id: 'mail', label: 'Mail', backgroundSupported: true },
  { id: 'calendar', label: 'Calendar and ToDo', backgroundSupported: true },
  { id: 'contacts', label: 'Contacts', backgroundSupported: false },
  { id: 'recordings', label: 'Recordings', backgroundSupported: false },
  { id: 'games', label: 'Games', backgroundSupported: false },
  { id: 'notes', label: 'Notes', backgroundSupported: false },
].map(module => Object.freeze({ ...module, recoverySection: module.id, visible: true, enabled: true, background: true })));

function getModuleForPath(pathname) {
  const match = /^\/api\/(mail|calendar|contacts|recordings|games|notes)(?:\/|$)/.exec(pathname);
  if (match) return match[1];
  // Settings remain accessible, but their module-specific operations follow the gate.
  if (pathname.startsWith('/api/settings/clear-mail') || pathname === '/api/settings/mail-sender-candidates') return 'mail';
  for (const id of ['contacts', 'calendar', 'recordings']) if (pathname === `/api/settings/clear-${id}`) return id;
  return null;
}
module.exports = { MODULE_CATALOG, getModuleForPath };
