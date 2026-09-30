const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function worker() {
  const listeners = {}; const shown = []; const delivered = new Map();
  let userId = 'user-1'; let fail = false;
  const context = vm.createContext({ URL, console, Promise, AbortController, setTimeout, clearTimeout,
    self: { location: { origin: 'https://unihub.test' },
      addEventListener(type, callback) { listeners[type] = callback; },
      registration: { async showNotification(title, options) { if (fail) throw new Error('Denied'); shown.push({ title, options }); } },
      clients: { async matchAll() { return []; } },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/sw-custom.js'), 'utf8'), context);
  context.readStore = async (store, key) => store === 'meta' ? userId : delivered.get(key);
  context.markDelivered = async key => delivered.set(key, true);
  return { context, shown, delivered, listeners, setUser(value) { userId = value; }, fail() { fail = true; } };
}
const payload = { version: 1, userId: 'user-1', dedupeKey: 'reminder:e1:2026-09-06T12:00:00.000Z:0', kind: 'reminder', title: 'At-start reminder', url: '/calendar', reminderMinutes: 0 };

test('push works without window clients; sequential duplicate does not double-deliver', async () => {
  const fixture = worker();
  const dispatch = () => new Promise((resolve, reject) => fixture.listeners.push({ data: { json: () => payload }, waitUntil: promise => promise.then(resolve, reject) }));
  await Promise.all([dispatch(), dispatch()]);
  assert.equal(fixture.shown.length, 1);
  assert.equal(fixture.delivered.size, 1);
  assert.equal(fixture.shown[0].options.data.url, 'https://unihub.test/calendar');
});
test('failed display is not recorded delivered; account mismatch cannot expose previous user', async () => {
  const fixture = worker();
  fixture.setUser('user-2');
  assert.equal(await fixture.context.deliverNotification(payload), false);
  assert.equal(fixture.delivered.size, 0);
  fixture.setUser('user-1'); fixture.fail();
  await assert.rejects(fixture.context.deliverNotification(payload));
  assert.equal(fixture.delivered.size, 0);
});
test('retired periodic checks neither poll nor consume notifications', async () => {
  const fixture = worker();
  await new Promise(resolve => fixture.listeners.periodicsync({ waitUntil: promise => promise.then(resolve) }));
  assert.equal(fixture.delivered.size, 0);
  assert.equal(fixture.shown.length, 0);
});
test('notification links cannot navigate to an external origin', () => {
  const fixture = worker();
  assert.equal(fixture.context.safeTargetUrl('https://attacker.test/'), 'https://unihub.test/dashboard');
});

test('worker identity binding rejects stale accounts and retains existing identity during transient offline errors', async () => {
  const fixture = worker();
  fixture.context.AbortSignal = AbortSignal;
  fixture.context.fetch = async () => ({ ok: true, json: async () => ({ user: { id: 'user-2' } }) });
  fixture.context.setUser = async value => fixture.setUser(value);
  assert.equal(await fixture.context.bindAuthenticatedUser('user-1'), false);
  assert.equal(await fixture.context.bindAuthenticatedUser('user-2'), true);
  fixture.context.fetch = async () => { throw new TypeError('Offline'); };
  assert.equal(await fixture.context.bindAuthenticatedUser('user-2'), true);
  assert.equal(await fixture.context.bindAuthenticatedUser('user-1'), false);
});

test('malformed notification URLs fall back to the app without throwing', () => {
  const fixture = worker();
  assert.equal(fixture.context.safeTargetUrl('https://['), 'https://unihub.test/dashboard');
  assert.equal(fixture.context.safeTargetUrl({ malicious: true }), 'https://unihub.test/dashboard');
});

test('legacy item IDs become exact same-origin notification links without changing deduplication', async () => {
  const fixture = worker();
  for (const [url, idKey, query] of [['/mail', 'emailId', 'email'], ['/calendar', 'eventId', 'event'], ['/todo', 'eventId', 'event']]) {
    const data = { ...payload, url, [idKey]: 'item-1', dedupeKey: `stable:${url}:item-1` };
    await fixture.context.deliverNotification(data);
    const notification = fixture.shown.at(-1);
    assert.equal(notification.options.data.url, `https://unihub.test${url}?${query}=item-1`);
    assert.equal(notification.options.tag, data.dedupeKey);
    assert.equal(fixture.delivered.has(`user-1:${data.dedupeKey}`), true);
  }
  assert.equal(fixture.context.notificationTargetUrl({ url: 'https://attacker.test/mail', emailId: 'secret' }), 'https://unihub.test/dashboard');
  const target = new URL(fixture.context.notificationTargetUrl({ url: '/mail', emailId: 'id&redirect=https://attacker.test' }));
  assert.equal(target.origin, 'https://unihub.test');
  assert.equal(target.searchParams.get('email'), 'id&redirect=https://attacker.test');
  assert.equal(target.searchParams.has('redirect'), false);
});

test('clicks navigate or open the exact item and never open a previous account notification', async () => {
  const fixture = worker();
  const visited = [];
  const client = { url: 'https://unihub.test/dashboard',
    async navigate(url) { visited.push(url); return this; }, async focus() { visited.push('focused'); } };
  fixture.context.self.clients.matchAll = async () => [client];
  fixture.context.self.clients.openWindow = async url => visited.push(url);
  const click = data => new Promise((resolve, reject) => fixture.listeners.notificationclick({
    notification: { close() {}, data }, waitUntil: task => task.then(resolve, reject),
  }));
  await click({ userId: 'user-1', url: '/mail', emailId: 'mail-1' });
  assert.deepEqual(visited.splice(0), ['https://unihub.test/mail?email=mail-1', 'focused']);
  fixture.context.self.clients.matchAll = async () => [];
  await click({ userId: 'user-1', url: '/todo', eventId: 'todo-1' });
  assert.deepEqual(visited.splice(0), ['https://unihub.test/todo?event=todo-1']);
  await click({ userId: 'user-2', url: '/calendar', eventId: 'private-event' });
  assert.equal(visited.length, 0);
});
