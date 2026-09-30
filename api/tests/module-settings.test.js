const test = require('node:test');
const assert = require('node:assert/strict');
const { MODULE_CATALOG, getModuleForPath } = require('../src/services/module-catalog');
const { modulesFromValue, validateModuleUpdates, getUserModules, setUserModules, isModuleEnabled, isModuleBackgroundEnabled } = require('../src/services/module-settings');
const { SECTION_POLICIES } = require('../src/services/backup-catalog');

test('all built-in modules default on and reference recoverable data', () => {
  const modules = modulesFromValue(null);
  assert.deepEqual(modules.map(m => m.id), ['mail', 'calendar', 'contacts', 'recordings', 'games', 'notes']);
  for (const module of modules) {
    assert.equal(module.visible && module.enabled && module.background, true);
    assert.ok(SECTION_POLICIES[module.recoverySection]);
  }
  assert.equal(MODULE_CATALOG.some(m => m.id === 'settings'), false);
  assert.deepEqual(modules.map(module => module.recoverySection).sort(), Object.keys(SECTION_POLICIES).filter(id => id !== 'settings').sort());
});
test('module updates reject unknown IDs, controls, owner injection and non-booleans', () => {
  for (const input of [null, {}, { modules: [] }, { modules: { unknown: {} } }, { modules: { mail: { enabled: 0 } } }, { modules: { mail: { owner: 'other' } } }, { modules: {}, userId: 'other' }]) {
    assert.throws(() => validateModuleUpdates(input), { status: 400 });
  }
});
test('saved owner settings retain independent hide, disable and background choices', async () => {
  const records = new Map(); const writes = [];
  const connection = { async execute(sql, params) {
    const key = params[0];
    if (sql.startsWith('INSERT INTO user_settings')) {
      assert.match(sql, /JSON_MERGE_PATCH/);
      writes.push(sql);
      const merged = records.get(key) || {};
      for (const [id, values] of Object.entries(JSON.parse(params[2]))) merged[id] = { ...merged[id], ...values };
      records.set(key, merged);
      return [{ affectedRows: 1 }];
    }
    assert.match(sql, /WHERE user_id = \? AND setting_key = \?/);
    return [records.has(key) ? [{ setting_value: JSON.stringify(records.get(key)) }] : []];
  } };
  await setUserModules('owner', { modules: { mail: { visible: false }, calendar: { background: false }, notes: { enabled: false } } }, connection);
  await setUserModules('owner', { modules: { mail: { background: false } } }, connection);
  const modules = await getUserModules('owner', connection);
  assert.equal(modules.find(m => m.id === 'mail').visible, false);
  assert.equal(await isModuleEnabled('owner', 'mail', connection), true);
  assert.equal(await isModuleBackgroundEnabled('owner', 'mail', connection), false);
  assert.equal(await isModuleEnabled('owner', 'notes', connection), false);
  assert.equal(await isModuleEnabled('other', 'notes', connection), true);
  assert.equal(writes.length, 2);
  await assert.rejects(setUserModules('owner', { modules: { mail: { enabled: 'no' } } }, connection));
  assert.equal(writes.length, 2);
});
test('module checks fail closed on database failure and malformed saved settings', async () => {
  await assert.rejects(isModuleEnabled('u', 'mail', { execute: async () => { throw new Error('Database unavailable'); } }), /Database unavailable/);
  assert.throws(() => modulesFromValue('{broken'));
});
test('module path gates include attachments and destructive settings while preserving core routes', () => {
  for (const path of ['/api/mail/attachments/id', '/api/mail/emails', '/api/settings/clear-mail-accounts']) assert.equal(getModuleForPath(path), 'mail');
  assert.equal(getModuleForPath('/api/notes/id/attachments/attachment/download'), 'notes');
  for (const path of ['/api/settings/preferences', '/api/settings/account', '/api/backup/export', '/api/auth/profile', '/api/modules']) assert.equal(getModuleForPath(path), null);
});
