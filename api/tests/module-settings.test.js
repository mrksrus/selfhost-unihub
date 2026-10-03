const test = require('node:test');
const assert = require('node:assert/strict');
const { MODULE_CATALOG, getModuleForPath } = require('../src/services/module-catalog');
const { ORDER_KEY, SETTING_KEY, modulesFromValue, orderFromValue, validateModuleUpdates, validateModuleRequest, getUserModules, getOrderedUserModules, setUserModules, isModuleEnabled, isModuleBackgroundEnabled } = require('../src/services/module-settings');
const { SECTION_POLICIES } = require('../src/services/backup-catalog');
const { validateBackupPayload } = require('../src/services/backup-validate');

test('all built-in modules default on and reference recoverable data', () => {
  const modules = modulesFromValue(null);
  assert.deepEqual(modules.map(m => m.id), ['mail', 'calendar', 'contacts', 'recordings']);
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
  await setUserModules('owner', { modules: { mail: { visible: false }, calendar: { background: false }, recordings: { enabled: false } } }, connection);
  await setUserModules('owner', { modules: { mail: { background: false } } }, connection);
  const modules = await getUserModules('owner', connection);
  assert.equal(modules.find(m => m.id === 'mail').visible, false);
  assert.equal(await isModuleEnabled('owner', 'mail', connection), true);
  assert.equal(await isModuleBackgroundEnabled('owner', 'mail', connection), false);
  assert.equal(await isModuleEnabled('owner', 'recordings', connection), false);
  assert.equal(await isModuleEnabled('other', 'recordings', connection), true);
  assert.equal(writes.length, 2);
  await assert.rejects(setUserModules('owner', { modules: { mail: { enabled: 'no' } } }, connection));
  assert.equal(writes.length, 2);
});
test('legacy saved games and notes choices are ignored on read, backup validation and later saves', async () => {
  const stored = { games: { visible: false }, notes: { enabled: false }, mail: { visible: false } };
  const modules = modulesFromValue(JSON.stringify(stored));
  assert.deepEqual(modules.map(m => m.id), ['mail', 'calendar', 'contacts', 'recordings']);
  assert.equal(modules.find(m => m.id === 'mail').visible, false);
  assert.deepEqual(validateBackupPayload({ version: 1, user: { id: 'u', email: 'a@example.com' },
    data: { user_settings: [{ user_id: 'u', setting_key: 'module_preferences', setting_value: JSON.stringify(stored) }] } })
    .errors.filter(error => /module preferences/.test(error)), []);
  const connection = { async execute(sql, params) {
    if (sql.startsWith('INSERT INTO user_settings')) {
      for (const [id, values] of Object.entries(JSON.parse(params[2]))) stored[id] = { ...stored[id], ...values };
      return [{ affectedRows: 1 }];
    }
    return [[{ setting_value: JSON.stringify(stored) }]];
  } };
  const updated = await setUserModules('owner', { modules: { recordings: { enabled: false } } }, connection);
  assert.equal(updated.find(m => m.id === 'recordings').enabled, false);
  assert.equal(updated.some(m => m.id === 'games' || m.id === 'notes'), false);
  assert.equal(await isModuleEnabled('owner', 'mail', connection), true);
  for (const id of ['games', 'notes']) assert.throws(() => validateModuleUpdates({ modules: { [id]: { visible: true } } }), { status: 400 });
  assert.equal(getModuleForPath('/api/games/tetris/leaderboard'), null);
  assert.equal(getModuleForPath('/api/notes/id/export'), null);
});
test('module checks fail closed on database failure and malformed saved settings', async () => {
  await assert.rejects(isModuleEnabled('u', 'mail', { execute: async () => { throw new Error('Database unavailable'); } }), /Database unavailable/);
  assert.throws(() => modulesFromValue('{broken'));
});
test('module path gates include attachments and destructive settings while preserving core routes', () => {
  for (const path of ['/api/mail/attachments/id', '/api/mail/emails', '/api/settings/clear-mail-accounts']) assert.equal(getModuleForPath(path), 'mail');
  assert.equal(getModuleForPath('/api/recordings/id/audio'), 'recordings');
  for (const path of ['/api/settings/preferences', '/api/settings/account', '/api/backup/export', '/api/auth/profile', '/api/modules']) assert.equal(getModuleForPath(path), null);
});

function keyedSettings(initial = {}) {
  const records = new Map(Object.entries(initial));
  const writes = [];
  return { records, writes, async execute(sql, params) {
    const id = `${params[0]}:${params[1]}`;
    if (sql.startsWith('INSERT INTO user_settings')) {
      writes.push(params[1]);
      if (params[1] === SETTING_KEY) {
        const merged = JSON.parse(records.get(id) || '{}');
        for (const [module, values] of Object.entries(JSON.parse(params[2]))) merged[module] = { ...merged[module], ...values };
        records.set(id, JSON.stringify(merged));
      } else records.set(id, params[2]);
      return [{ affectedRows: 1 }];
    }
    assert.match(sql, /WHERE user_id = \? AND setting_key = \?/);
    return [records.has(id) ? [{ setting_value: records.get(id) }] : []];
  } };
}

test('module order is saved per owner and shown in that order, while access checks keep catalog order', async () => {
  const connection = keyedSettings();
  const order = ['recordings', 'mail', 'contacts', 'calendar'];
  const updated = await setUserModules('owner', { order }, connection);
  assert.deepEqual(updated.map(m => m.id), order);
  assert.deepEqual(connection.writes, [ORDER_KEY]);
  assert.deepEqual((await getOrderedUserModules('owner', connection)).map(m => m.id), order);
  assert.deepEqual((await getUserModules('owner', connection)).map(m => m.id), ['mail', 'calendar', 'contacts', 'recordings']);
  assert.deepEqual((await getOrderedUserModules('other', connection)).map(m => m.id), ['mail', 'calendar', 'contacts', 'recordings']);
  const both = await setUserModules('owner', { modules: { mail: { visible: false } }, order: ['mail', 'calendar', 'contacts', 'recordings'] }, connection);
  assert.deepEqual(both.map(m => m.id), ['mail', 'calendar', 'contacts', 'recordings']);
  assert.equal(both.find(m => m.id === 'mail').visible, false);
});

test('module order requests must list every current module once', () => {
  for (const input of [{}, { order: null }, { order: 'mail' }, { order: ['mail', 'calendar', 'contacts'] },
    { order: ['mail', 'mail', 'contacts', 'recordings'] }, { order: ['mail', 'calendar', 'contacts', 'recordings', 'notes'] },
    { order: ['mail', 'calendar', 'contacts', 'notes'] }, { order: ['mail', 'calendar', 'contacts', 'recordings'], userId: 'other' }]) {
    assert.throws(() => validateModuleRequest(input), { status: 400 }, JSON.stringify(input));
  }
  assert.deepEqual(validateModuleRequest({ order: ['contacts', 'mail', 'calendar', 'recordings'] }).modules, null);
});

test('saved order from older releases or backups never hides or breaks modules', () => {
  // Removed modules are dropped, modules missing from an older order follow in catalog order.
  assert.deepEqual(orderFromValue(JSON.stringify(['notes', 'recordings', 'games', 'mail'])), ['recordings', 'mail', 'calendar', 'contacts']);
  for (const value of [null, '{broken', '{"mail":1}', '"mail"', JSON.stringify(['mail', 'mail', 7])]) {
    assert.deepEqual(orderFromValue(value), ['mail', 'calendar', 'contacts', 'recordings'], String(value));
  }
});
