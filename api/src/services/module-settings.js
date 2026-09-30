const { db } = require('../state');
const { MODULE_CATALOG } = require('./module-catalog');
const SETTING_KEY = 'module_preferences';
const ids = new Set(MODULE_CATALOG.map(module => module.id));
const fields = new Set(['visible', 'enabled', 'background']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateModuleUpdates(input) {
  if (!isObject(input) || Object.keys(input).some(key => key !== 'modules') || !isObject(input.modules)) {
    throw Object.assign(new Error('Expected modules object'), { status: 400 });
  }
  for (const [id, changes] of Object.entries(input.modules)) {
    if (!ids.has(id) || !isObject(changes) || Object.entries(changes).some(([key, value]) => !fields.has(key) || typeof value !== 'boolean')) {
      throw Object.assign(new Error(`Invalid module preferences for ${id}`), { status: 400 });
    }
  }
  return input.modules;
}

function modulesFromValue(value) {
  const saved = value == null ? {} : typeof value === 'string' ? JSON.parse(value) : value;
  validateModuleUpdates({ modules: saved });
  return MODULE_CATALOG.map(module => ({ ...module, ...(saved[module.id] || {}) }));
}

async function getUserModules(userId, connection = db) {
  const [rows] = await connection.execute('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = ?', [userId, SETTING_KEY]);
  return modulesFromValue(rows[0]?.setting_value);
}
async function isModuleEnabled(userId, id, connection = db) {
  return (await getUserModules(userId, connection)).find(module => module.id === id)?.enabled === true;
}
async function isModuleBackgroundEnabled(userId, id, connection = db) {
  const module = (await getUserModules(userId, connection)).find(module => module.id === id);
  return !!(module?.enabled && module.background);
}
async function setUserModules(userId, input, connection = db) {
  const updates = validateModuleUpdates(input);
  // Merge in one database statement so concurrent updates to different controls
  // cannot overwrite one another. user_settings is already archived and owner-scoped.
  await connection.execute(`INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE setting_value = JSON_MERGE_PATCH(setting_value, VALUES(setting_value))`,
  [userId, SETTING_KEY, JSON.stringify(updates)]);
  return getUserModules(userId, connection);
}
async function getBackgroundPausedModulesByUser(connection = db) {
  const [rows] = await connection.execute('SELECT user_id, setting_value FROM user_settings WHERE setting_key = ?', [SETTING_KEY]);
  return new Map(rows.map(row => [row.user_id, new Set(modulesFromValue(row.setting_value).filter(module => !module.enabled || !module.background).map(module => module.id))]));
}
module.exports = { getBackgroundPausedModulesByUser, SETTING_KEY, modulesFromValue, validateModuleUpdates, getUserModules, isModuleEnabled, isModuleBackgroundEnabled, setUserModules };
