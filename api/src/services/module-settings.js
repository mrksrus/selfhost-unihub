const { db } = require('../state');
const { MODULE_CATALOG, RETIRED_MODULE_IDS } = require('./module-catalog');
const SETTING_KEY = 'module_preferences';
const ORDER_KEY = 'module_order';
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

// A saved order must list every current module exactly once.
function validateModuleOrder(order) {
  if (!Array.isArray(order) || order.length !== ids.size || new Set(order).size !== order.length || order.some(id => !ids.has(id))) {
    throw Object.assign(new Error('Module order must list every module once'), { status: 400 });
  }
  return order;
}

function validateModuleRequest(input) {
  if (!isObject(input) || !Object.keys(input).length || Object.keys(input).some(key => key !== 'modules' && key !== 'order')) {
    throw Object.assign(new Error('Expected modules object or order list'), { status: 400 });
  }
  return {
    modules: input.modules === undefined ? null : validateModuleUpdates({ modules: input.modules }),
    order: input.order === undefined ? null : validateModuleOrder(input.order),
  };
}

// Order is a display preference only. Ids from removed modules are dropped and
// modules added after the order was saved follow in catalog order, so an old
// order (or one restored from an old backup) never hides a module.
function orderFromValue(value) {
  let parsed;
  try { parsed = value == null ? [] : typeof value === 'string' ? JSON.parse(value) : value; } catch { parsed = []; }
  const saved = Array.isArray(parsed) ? [...new Set(parsed.filter(id => ids.has(id)))] : [];
  return [...saved, ...MODULE_CATALOG.map(module => module.id).filter(id => !saved.includes(id))];
}

function modulesFromValue(value) {
  const parsed = value == null ? {} : typeof value === 'string' ? JSON.parse(value) : value;
  // Older releases saved choices for since-removed modules (e.g. games); drop them
  // so existing settings and backups stay readable.
  const saved = isObject(parsed) ? Object.fromEntries(Object.entries(parsed).filter(([id]) => !RETIRED_MODULE_IDS.includes(id))) : parsed;
  validateModuleUpdates({ modules: saved });
  return MODULE_CATALOG.map(module => ({ ...module, ...(saved[module.id] || {}) }));
}

function sortModules(modules, orderValue) {
  const order = orderFromValue(orderValue);
  return [...modules].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

async function getUserModules(userId, connection = db) {
  const [rows] = await connection.execute('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = ?', [userId, SETTING_KEY]);
  return modulesFromValue(rows[0]?.setting_value);
}
// Only the module list shown to the user needs their order; access checks use catalog order.
async function getOrderedUserModules(userId, connection = db) {
  const [rows] = await connection.execute('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = ?', [userId, ORDER_KEY]);
  return sortModules(await getUserModules(userId, connection), rows[0]?.setting_value);
}
async function isModuleEnabled(userId, id, connection = db) {
  return (await getUserModules(userId, connection)).find(module => module.id === id)?.enabled === true;
}
async function isModuleBackgroundEnabled(userId, id, connection = db) {
  const module = (await getUserModules(userId, connection)).find(module => module.id === id);
  return !!(module?.enabled && module.background);
}
async function setUserModules(userId, input, connection = db) {
  const { modules: updates, order } = validateModuleRequest(input);
  // Merge in one database statement so concurrent updates to different controls
  // cannot overwrite one another. user_settings is already archived and owner-scoped.
  if (updates) await connection.execute(`INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE setting_value = JSON_MERGE_PATCH(setting_value, VALUES(setting_value))`,
  [userId, SETTING_KEY, JSON.stringify(updates)]);
  if (order) await connection.execute(`INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
  [userId, ORDER_KEY, JSON.stringify(order)]);
  return getOrderedUserModules(userId, connection);
}
async function getBackgroundPausedModulesByUser(connection = db) {
  const [rows] = await connection.execute('SELECT user_id, setting_value FROM user_settings WHERE setting_key = ?', [SETTING_KEY]);
  return new Map(rows.map(row => [row.user_id, new Set(modulesFromValue(row.setting_value).filter(module => !module.enabled || !module.background).map(module => module.id))]));
}
module.exports = { getBackgroundPausedModulesByUser, SETTING_KEY, ORDER_KEY, modulesFromValue, orderFromValue, validateModuleUpdates, validateModuleRequest, getUserModules, getOrderedUserModules, isModuleEnabled, isModuleBackgroundEnabled, setUserModules };
