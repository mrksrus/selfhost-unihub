import { serverEvents } from './server-events';
import { onMailModuleChanged } from './mail-sync-control';

// What a saved module choice means for running work. PUT /api/modules saves
// the preferences and then calls applyModuleChange with the states before and
// after; each module with background work registers a hook here, so the route
// knows nothing about engines and a new module adds one line.
interface ModuleState { id: string; enabled: boolean; background: boolean }
type ModuleHook = (userId: string, next: ModuleState) => Promise<void>;

const MODULE_HOOKS: Readonly<Record<string, ModuleHook>> = Object.freeze({
  mail: (userId, next) => onMailModuleChanged(userId, next),
});

async function applyModuleChange(userId: string, previous: readonly ModuleState[], next: readonly ModuleState[]) {
  // Open event streams filter by the enabled set from now on.
  serverEvents.setUserModules(userId, next.filter(module => module.enabled).map(module => module.id));
  for (const module of next) {
    const before = previous.find(candidate => candidate.id === module.id);
    if (before && before.enabled === module.enabled && before.background === module.background) continue;
    await MODULE_HOOKS[module.id]?.(userId, module);
  }
}

export { applyModuleChange };
export type { ModuleState };
