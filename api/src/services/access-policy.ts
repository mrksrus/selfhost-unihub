import type { SqlExecutor } from '../types';

import { db } from '../state';
import { MODULE_CATALOG } from './module-catalog';
import { isModuleEnabled, isModuleBackgroundEnabled, getBackgroundPausedModulesByUser } from './module-settings';
import { isSectionRestoreActive, getActiveRestoreSectionsByUser } from './restore-locks';

// One answer to "may this module do work for this user right now": the user
// must have the module enabled (and, for unattended work, background work
// allowed), and no restore of the module's recovery section may be running.
// The request boundary answers the same question in two steps because it
// reports the two causes with different responses; services that need a
// per-cause message keep their own two checks as well.
const sectionOf = (moduleId: string) => MODULE_CATALOG.find(module => module.id === moduleId)?.recoverySection ?? moduleId;

async function canRunModule(userId: string, moduleId: string, { background = false, executor = db }: { background?: boolean; executor?: SqlExecutor } = {}) {
  if (await isSectionRestoreActive(userId, sectionOf(moduleId), executor)) return false;
  return background ? isModuleBackgroundEnabled(userId, moduleId, executor) : isModuleEnabled(userId, moduleId, executor);
}

// For workers that scan every user in one pass: per user, the modules whose
// background work is paused (module or background switched off) together with
// the sections being restored. Module ids and section names coincide.
async function blockedBackgroundModulesByUser(connection: SqlExecutor = db) {
  const blocked = await getActiveRestoreSectionsByUser(connection);
  for (const [userId, modules] of await getBackgroundPausedModulesByUser(connection)) {
    const sections = blocked.get(userId) || new Set<string>();
    for (const id of modules) sections.add(id);
    blocked.set(userId, sections);
  }
  return blocked;
}

export { canRunModule, blockedBackgroundModulesByUser };
