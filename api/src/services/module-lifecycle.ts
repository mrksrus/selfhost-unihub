import { realtime } from './realtime';
import { log } from '../log';
import { onMailModuleChanged } from './mail-sync-control';
import { getOwnModules, withModulePolicies } from './module-settings';
import { policyOff, takeUnappliedModules } from './settings';
import { syncTwoFactorGrace } from './sign-in-policies';

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
  realtime.setUserModules(userId, next.filter(module => module.enabled).map(module => module.id));
  for (const module of next) {
    const before = previous.find(candidate => candidate.id === module.id);
    if (before && before.enabled === module.enabled && before.background === module.background) continue;
    await MODULE_HOOKS[module.id]?.(userId, module);
  }
}

/**
 * After a policy save or a membership change committed (settings.ts
 * lockRules ... checkPeoplePolicies), for each person it reached whose
 * policies changed: the modules a policy turned off or on run the same
 * hooks as the person's own switch, and open event streams filter by the
 * modules now on.
 */
async function applyPolicyChange(userIds: readonly string[]): Promise<void> {
  // The 2FA grace counts from the change that made the rule apply (and ends
  // with the one that lifts it); the gate starts any this misses.
  await syncTwoFactorGrace(userIds).catch(error => log.error('POLICY', 'Starting or ending 2FA graces failed', error));
  for (const userId of userIds) {
    const before = takeUnappliedModules(userId);
    if (!before) continue;
    const own = await getOwnModules(userId);
    const previous = withModulePolicies(own, before);
    const next = withModulePolicies(own, (await policyOff(userId)).modules);
    if (previous.every((module, index) => module.enabled === next[index].enabled)) continue;
    await applyModuleChange(userId, previous, next);
  }
}

export { applyModuleChange, applyPolicyChange };
export type { ModuleState };
