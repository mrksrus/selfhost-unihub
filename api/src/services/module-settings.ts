import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';

import { db } from '../state';
import { MODULE_CATALOG, PAGE_CATALOG, RETIRED_MODULE_IDS } from './module-catalog';

interface ModulePreferences { id: string; visible: boolean; enabled: boolean; background: boolean }
type ModuleUpdates = Record<string, Partial<Pick<ModulePreferences, 'visible' | 'enabled' | 'background'>>>;
type PageUpdates = Record<string, { visible?: boolean }>;
const SETTING_KEY = 'module_preferences';
const ORDER_KEY = 'module_order';
const PAGE_SETTING_KEY = 'page_preferences';
const PAGE_ORDER_KEY = 'page_order';
const ids = new Set(MODULE_CATALOG.map(module => module.id));
const pageIds = new Set(PAGE_CATALOG.map(page => page.id));
const fields = new Set(['visible', 'enabled', 'background']);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateModuleUpdates(input: unknown): ModuleUpdates {
  if (!isObject(input) || Object.keys(input).some(key => key !== 'modules') || !isObject(input.modules)) {
    throw Object.assign(new Error('Expected modules object'), { status: 400 });
  }
  for (const [id, changes] of Object.entries(input.modules)) {
    if (!ids.has(id) || !isObject(changes) || Object.entries(changes).some(([key, value]) => !fields.has(key) || typeof value !== 'boolean')) {
      throw Object.assign(new Error(`Invalid module preferences for ${id}`), { status: 400 });
    }
  }
  return input.modules as ModuleUpdates;
}

// A saved order must list every current module exactly once.
function validateModuleOrder(order: unknown): string[] {
  if (!Array.isArray(order) || order.length !== ids.size || new Set(order).size !== order.length || order.some(id => !ids.has(id))) {
    throw Object.assign(new Error('Module order must list every module once'), { status: 400 });
  }
  return order;
}

// Pages are only shown or hidden; enabling stays with the module.
function validatePageUpdates(pages: unknown): PageUpdates {
  if (!isObject(pages)) throw Object.assign(new Error('Expected pages object'), { status: 400 });
  for (const [id, changes] of Object.entries(pages)) {
    if (!pageIds.has(id) || !isObject(changes) || Object.entries(changes).some(([key, value]) => key !== 'visible' || typeof value !== 'boolean')) {
      throw Object.assign(new Error(`Invalid page preferences for ${id}`), { status: 400 });
    }
  }
  return pages as PageUpdates;
}

function validatePageOrder(order: unknown): string[] {
  if (!Array.isArray(order) || order.length !== pageIds.size || new Set(order).size !== order.length || order.some(id => !pageIds.has(id))) {
    throw Object.assign(new Error('Page order must list every page once'), { status: 400 });
  }
  return order;
}

const requestKeys = new Set(['modules', 'order', 'pages', 'page_order']);
function validateModuleRequest(input: unknown) {
  if (!isObject(input) || !Object.keys(input).length || Object.keys(input).some(key => !requestKeys.has(key))) {
    throw Object.assign(new Error('Expected modules, pages or an order list'), { status: 400 });
  }
  return {
    modules: input.modules === undefined ? null : validateModuleUpdates({ modules: input.modules }),
    order: input.order === undefined ? null : validateModuleOrder(input.order),
    pages: input.pages === undefined ? null : validatePageUpdates(input.pages),
    pageOrder: input.page_order === undefined ? null : validatePageOrder(input.page_order),
  };
}

// Order is a display preference only. Ids from removed modules are dropped and
// modules added after the order was saved follow in catalog order, so an old
// order (or one restored from an old backup) never hides a module.
function orderFromValue(value: unknown): string[] {
  let parsed: unknown;
  try { parsed = value == null ? [] : typeof value === 'string' ? JSON.parse(value) : value; } catch { parsed = []; }
  const saved = Array.isArray(parsed) ? [...new Set(parsed.filter(id => ids.has(id)))] : [];
  return [...saved, ...MODULE_CATALOG.map(module => module.id).filter(id => !saved.includes(id))];
}

// Page choices only change the navigation, so anything unreadable in them is
// ignored instead of failing the request.
function pagePreferencesFromValue(value: unknown): Record<string, boolean> {
  let parsed: unknown;
  try { parsed = value == null ? {} : typeof value === 'string' ? JSON.parse(value) : value; } catch { parsed = {}; }
  if (!isObject(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed)
    .filter(([id, choice]) => pageIds.has(id) && isObject(choice) && typeof choice.visible === 'boolean')
    .map(([id, choice]) => [id, (choice as { visible: boolean }).visible]));
}

// Without a saved page order, pages follow the module order (Calendar before
// ToDo, Recordings before Music) and Today comes last.
function pageOrderFromValue(value: unknown, moduleOrder = orderFromValue(null)) {
  let parsed: unknown;
  try { parsed = value == null ? [] : typeof value === 'string' ? JSON.parse(value) : value; } catch { parsed = []; }
  const saved = Array.isArray(parsed) ? [...new Set(parsed.filter(id => pageIds.has(id)))] : [];
  const fallback = [
    ...moduleOrder.flatMap(moduleId => PAGE_CATALOG.filter(page => page.module === moduleId).map(page => page.id)),
    ...PAGE_CATALOG.filter(page => !page.module).map(page => page.id),
  ];
  return [...saved, ...fallback.filter(id => !saved.includes(id))];
}

// A page without its own choice follows the module's older "Show in
// navigation" choice, so hiding Calendar and ToDo before 0.17.4 still hides both.
function pagesFromValues(modules: readonly ModulePreferences[], moduleOrder: string[], preferencesValue: unknown, orderValue: unknown) {
  const choices = pagePreferencesFromValue(preferencesValue);
  const moduleVisible = new Map(modules.map(module => [module.id, module.visible !== false]));
  return pageOrderFromValue(orderValue, moduleOrder).map(id => {
    const page = PAGE_CATALOG.find(entry => entry.id === id)!;
    return { ...page, visible: choices[id] ?? (page.module ? moduleVisible.get(page.module) !== false : true) };
  });
}

function modulesFromValue(value: unknown) {
  const parsed: unknown = value == null ? {} : typeof value === 'string' ? JSON.parse(value) : value;
  // Older releases saved choices for since-removed modules (e.g. games); drop them
  // so existing settings and backups stay readable.
  const saved = isObject(parsed) ? Object.fromEntries(Object.entries(parsed).filter(([id]) => !RETIRED_MODULE_IDS.includes(id))) : parsed;
  const updates = validateModuleUpdates({ modules: saved });
  return MODULE_CATALOG.map(module => ({ ...module, ...(updates[module.id] || {}) }));
}

function sortModules<T extends { id: string }>(modules: readonly T[], orderValue: unknown) {
  const order = orderFromValue(orderValue);
  return [...modules].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

async function readSetting(userId: string, key: string, connection: SqlExecutor) {
  const [rows] = await connection.execute<(RowDataPacket & { setting_value: unknown })[]>('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = ?', [userId, key]);
  return rows[0]?.setting_value;
}
async function getUserModules(userId: string, connection: SqlExecutor = db) {
  return modulesFromValue(await readSetting(userId, SETTING_KEY, connection));
}
// Only the module list shown to the user needs their order; access checks use catalog order.
async function getOrderedUserModules(userId: string, connection: SqlExecutor = db) {
  return sortModules(await getUserModules(userId, connection), await readSetting(userId, ORDER_KEY, connection));
}
async function getUserPages(userId: string, connection: SqlExecutor = db) {
  const modules = await getUserModules(userId, connection);
  const moduleOrder = orderFromValue(await readSetting(userId, ORDER_KEY, connection));
  return pagesFromValues(modules, moduleOrder,
    await readSetting(userId, PAGE_SETTING_KEY, connection),
    await readSetting(userId, PAGE_ORDER_KEY, connection));
}
async function isModuleEnabled(userId: string, id: string, connection: SqlExecutor = db) {
  return (await getUserModules(userId, connection)).find(module => module.id === id)?.enabled === true;
}
async function isModuleBackgroundEnabled(userId: string, id: string, connection: SqlExecutor = db) {
  const module = (await getUserModules(userId, connection)).find(module => module.id === id);
  return !!(module?.enabled && module.background);
}
async function setUserModules(userId: string, input: unknown, connection: SqlExecutor = db) {
  const { modules: updates, order, pages, pageOrder } = validateModuleRequest(input);
  // Merge in one database statement so concurrent updates to different controls
  // cannot overwrite one another. user_settings is already archived and owner-scoped.
  if (updates) await connection.execute(`INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE setting_value = JSON_MERGE_PATCH(setting_value, VALUES(setting_value))`,
  [userId, SETTING_KEY, JSON.stringify(updates)]);
  if (order) await connection.execute(`INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
  [userId, ORDER_KEY, JSON.stringify(order)]);
  if (pages) await connection.execute(`INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE setting_value = IF(JSON_VALID(setting_value), JSON_MERGE_PATCH(setting_value, VALUES(setting_value)), VALUES(setting_value))`,
  [userId, PAGE_SETTING_KEY, JSON.stringify(pages)]);
  if (pageOrder) await connection.execute(`INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
  [userId, PAGE_ORDER_KEY, JSON.stringify(pageOrder)]);
  return getOrderedUserModules(userId, connection);
}
async function getBackgroundPausedModulesByUser(connection: SqlExecutor = db) {
  const [rows] = await connection.execute<(RowDataPacket & { user_id: string; setting_value: unknown })[]>('SELECT user_id, setting_value FROM user_settings WHERE setting_key = ?', [SETTING_KEY]);
  return new Map(rows.map(row => [row.user_id, new Set(modulesFromValue(row.setting_value).filter(module => !module.enabled || !module.background).map(module => module.id))]));
}
export {
  getBackgroundPausedModulesByUser,
  SETTING_KEY,
  ORDER_KEY,
  PAGE_SETTING_KEY,
  PAGE_ORDER_KEY,
  modulesFromValue,
  orderFromValue,
  pageOrderFromValue,
  pagesFromValues,
  getUserPages,
  validateModuleUpdates,
  validateModuleRequest,
  getUserModules,
  getOrderedUserModules,
  isModuleEnabled,
  isModuleBackgroundEnabled,
  setUserModules,
};
