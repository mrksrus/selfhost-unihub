import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deleteLockRecords } from '@/lib/app-lock/db';
import { noteActive, noteHidden, writeTimelineConfig } from '@/lib/app-lock/timeline';
import type { AppLockArea } from '../../api/src/contracts/devices';

// The service worker hides a notification's text while this person's app
// lock covers its module and no tab counts as open: it reads the timeline
// the page writes (lib/app-lock/timeline.ts) from the same IndexedDB. This
// runs the worker's real source against the page's real writes.

let source = '';
beforeAll(() => {
  const file = path.resolve(__dirname, '../../workers/sw-custom.ts');
  source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
});
afterEach(async () => { await deleteLockRecords(); });

type Shown = { title: string; options: { body: string; data: { url: string } } };
async function worker(userId = 'alex') {
  const shown: Shown[] = [];
  const self = {
    location: { origin: 'https://unihub.test' },
    addEventListener() {},
    registration: { async showNotification(title: string, options: Shown['options']) { shown.push({ title, options }); }, async getNotifications() { return []; } },
    clients: { async matchAll() { return []; } },
  };
  const context = vm.createContext({ self, indexedDB, URL, console, Promise, setTimeout, clearTimeout, Date, caches: { delete: async () => true } });
  vm.runInContext(source, context);
  await context.setUser(userId);
  return { shown, context, self: self as typeof self & { unihubWithBoundUser: <T>(userId: string, task: (bound: boolean) => Promise<T>) => Promise<T> } };
}

let count = 0;
const push = (fields: Record<string, unknown>) => ({ version: 1, userId: 'alex', dedupeKey: `key-${++count}`, url: '/mail', ...fields });
const mail = () => push({ kind: 'mail', title: 'New Email', body: 'Dana Example: Quarterly figures' });
const reminder = () => push({ kind: 'reminder', title: 'Dentist at 10', body: 'Event is starting now', url: '/calendar' });

async function lock(scope: AppLockArea[], { hiddenAgoMs }: { hiddenAgoMs: number | null }) {
  await writeTimelineConfig('alex', { scope, relockAfterMs: 60_000, onDeviceLock: false, method: 'pin' });
  if (hiddenAgoMs === null) await noteActive('alex', Date.now());
  else await noteHidden('alex', Date.now() - hiddenAgoMs);
}

describe('notifications while the app lock is on', () => {
  it('a locked module’s notification names nothing; another module’s keeps its text', async () => {
    await lock(['mail'], { hiddenAgoMs: 2 * 60_000 });
    const { shown, context } = await worker();
    expect(await context.deliverNotification(mail())).toBe(true);
    expect(await context.deliverNotification(reminder())).toBe(true);
    expect(shown[0]).toMatchObject({ title: 'UniHub', options: { body: 'You have a new notification. Unlock UniHub to see it.', data: { url: 'https://unihub.test/mail' } } });
    expect(JSON.stringify(shown[0])).not.toContain('Quarterly');
    expect(shown[1]).toMatchObject({ title: 'Dentist at 10', options: { body: 'Event is starting now' } });
  });

  it('shows the text while a tab is open or within the relock time', async () => {
    await lock(['mail'], { hiddenAgoMs: null });
    const open = await worker();
    await open.context.deliverNotification(mail());
    expect(open.shown[0].options.body).toBe('Dana Example: Quarterly figures');
    await lock(['mail'], { hiddenAgoMs: 20_000 });
    const recent = await worker();
    await recent.context.deliverNotification(mail());
    expect(recent.shown[0].options.body).toBe('Dana Example: Quarterly figures');
  });

  it('the whole-app lock also covers notices without a module; a module lock does not', async () => {
    const notice = () => push({ kind: 'session', title: 'Your session ends soon', body: 'Open UniHub to stay signed in.' });
    await lock(['mail'], { hiddenAgoMs: 5 * 60_000 });
    const modules = await worker();
    await modules.context.deliverNotification(notice());
    expect(modules.shown[0].title).toBe('Your session ends soon');
    await lock(['app'], { hiddenAgoMs: 5 * 60_000 });
    const app = await worker();
    await app.context.deliverNotification(notice());
    await app.context.deliverNotification(reminder());
    expect(app.shown.map(notification => notification.title)).toEqual(['UniHub', 'UniHub']);
  });

  it('the server’s module wins over the kind; a local reminder carries its own', async () => {
    await lock(['calendar'], { hiddenAgoMs: 5 * 60_000 });
    const { shown, context } = await worker();
    await context.deliverNotification(push({ kind: 'test', module: 'calendar', title: 'Private event', body: 'Details' }));
    expect(shown[0].title).toBe('UniHub');
  });

  it('another person’s lock does not change this person’s notifications, and a page that never locked shows everything', async () => {
    await writeTimelineConfig('blair', { scope: ['app'], relockAfterMs: 0, onDeviceLock: false, method: 'pin' });
    const { shown, context } = await worker();
    await context.deliverNotification(mail());
    expect(shown[0].options.body).toBe('Dana Example: Quarterly figures');
  });

  it('a recording upload notice leaves out the recording’s title while Recordings is locked', async () => {
    await lock(['recordings'], { hiddenAgoMs: 5 * 60_000 });
    const { self } = await worker();
    expect(await self.unihubWithBoundUser('alex', async bound => bound)).toBe(false);
    await lock(['mail'], { hiddenAgoMs: 5 * 60_000 });
    expect(await self.unihubWithBoundUser('alex', async bound => bound)).toBe(true);
  });
});
