// 32-08 to 32-11 (emulator half), D69: the Calendar and ToDo widgets on the
// home screen of the real app. Both are put there through Android's own "Add
// to home screen" dialog and read from the launcher's screen as a person sees
// them. A tick on the ToDo widget reaches the server, also while the app is
// locked (the app lock does not hide the widgets, the notification detail
// does); the least detail "none" leaves times and "Event" without ticks;
// signing out and another person's sign-in empty both widgets. Their look is
// checked elsewhere.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { people } from '../support/people.mjs';
import {
  PACKAGE, adb, enrollFingerprint, openApp, resetAppLock, screenNodes, setDevicePin, setPolicies, sleep, stackSession, tapNative, touch,
  touchFinger, waitForUnlockPrompt,
} from '../support/android.mjs';

const run = Date.now().toString(36);
const MEETING = `Widget meeting ${run}`;
const TASK = `Widget task ${run}`;
const LOCKED_TASK = `Locked task ${run}`;

/** Asks the launcher to place a widget and confirms its dialog. */
async function place(kind) {
  adb('shell', 'am', 'broadcast', '-n', `${PACKAGE}/.TestWidgets`, '--es', 'pin', kind);
  await tapNative(/^add( to home screen)?$/i, { timeoutMs: 60_000 });
  await sleep(2000);
}

/** The home screen after the widgets fetched again (the job the app schedules every 30 minutes, run now). */
function refreshed() {
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  adb('shell', 'cmd', 'jobscheduler', 'run', '-f', PACKAGE, '70');
}

/** Waits until the launcher's screen shows what `check` wants; answers its nodes. */
async function home(check, what, timeoutMs = 90_000) {
  let nodes = [];
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(2000)) {
    nodes = screenNodes();
    if (check(nodes)) return nodes;
  }
  assert.fail(`${what}; the screen showed: ${nodes.map(node => node.text || node.desc).filter(Boolean).join(' | ')}`);
}
const shows = text => nodes => nodes.some(node => node.text === text);

async function taskStatus(api, id) {
  const { status, data } = await api('GET', `/api/calendar/events/${id}`);
  assert.equal(status, 200, JSON.stringify(data));
  return data.event.todo_status;
}

before(async () => {
  await resetAppLock();
  setDevicePin();
  await enrollFingerprint();
});

after(async () => {
  await setPolicies({ 'notifications.detail': 'full' });
  await resetAppLock();
});

test('[32-08..32-11] both widgets on the home screen: a tick reaches the server, also locked; detail none hides titles; signing out and another person empty them', { timeout: 1_800_000 }, async () => {
  const api = await stackSession();
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setUTCHours(10, 0, 0, 0);
  const create = async body => {
    const { status, data } = await api('POST', '/api/calendar/events', { reminders: null, ...body });
    assert.equal(status, 200, JSON.stringify(data));
    return data.event;
  };
  const meeting = await create({ title: MEETING, start_time: tomorrow.toISOString(), end_time: new Date(tomorrow.getTime() + 3_600_000).toISOString() });
  const task = await create({ title: TASK, is_todo_only: true });
  const locked = await create({ title: LOCKED_TASK, is_todo_only: true });

  const { device, page } = await openApp();
  try {
    await place('agenda');
    await place('tasks');
    refreshed();
    await home(nodes => shows(MEETING)(nodes) && shows(TASK)(nodes), 'both widgets show the meeting and the task');

    // A tick on the home screen: done on the server, gone from the widget.
    await tapNative(new RegExp(`^Mark done: ${TASK}$`));
    for (const end = Date.now() + 60_000; Date.now() < end && await taskStatus(api, task.id) !== 'done'; await sleep(1000));
    assert.equal(await taskStatus(api, task.id), 'done', 'the tick reached the server');
    await home(nodes => !shows(TASK)(nodes) && shows(LOCKED_TASK)(nodes), 'the ticked task left the widget');

    // The whole app locked: the widgets keep their titles and the tick still works.
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
    await page.goto(new URL('/settings?section=app-lock', page.url()).href);
    await touch(page, page.getByText('Whole app', { exact: true }));
    await waitForUnlockPrompt();
    await touchFinger(1);
    await page.getByLabel('Ask again').selectOption({ label: 'Every time UniHub opens' }, { timeout: 5000 }).catch(async () => {
      await touch(page, page.getByRole('combobox', { name: 'Ask again' }));
      await touch(page, page.getByRole('option', { name: 'Every time UniHub opens' }));
    });
    await sleep(2000);
    refreshed();
    await home(shows(LOCKED_TASK), 'the locked app\'s widget keeps its titles');
    await tapNative(new RegExp(`^Mark done: ${LOCKED_TASK}$`));
    for (const end = Date.now() + 60_000; Date.now() < end && await taskStatus(api, locked.id) !== 'done'; await sleep(1000));
    assert.equal(await taskStatus(api, locked.id), 'done', 'the tick reached the server while the app was locked');

    // The least detail "none": times and "Event", no titles and no tick.
    const hidden = await create({ title: `Hidden task ${run}`, is_todo_only: true });
    await setPolicies({ 'notifications.detail': 'none' });
    refreshed();
    const plain = await home(nodes => shows('Event')(nodes) && !shows(MEETING)(nodes), 'titles hidden at detail none');
    assert.ok(!plain.some(node => /^Mark done:/.test(node.desc) || node.text.includes(hidden.title)), 'no title and no tick at detail none');
    await setPolicies({ 'notifications.detail': 'full' });

    // Signed out (the app's session ended): both widgets empty, with "Open UniHub".
    await resetAppLock();
    refreshed();
    const out = await home(nodes => nodes.filter(node => node.text === 'Sign in to UniHub to see this').length === 2, 'both widgets say to sign in');
    assert.ok(!out.some(node => node.text === MEETING) && out.some(node => node.text === 'Open UniHub'));

    // Another person signs in: none of the administrator's items come back.
    const other = await openApp({ email: 'alex@example.com' });
    await other.device.close();
    refreshed();
    const theirs = await home(nodes => !nodes.some(node => node.text === 'Sign in to UniHub to see this' || node.text === 'Loading…'), 'Alex\'s widgets loaded');
    assert.ok(!theirs.some(node => [MEETING, LOCKED_TASK].includes(node.text) || node.text === hidden.title), 'nothing of the administrator\'s');
    await api('DELETE', `/api/calendar/events/${hidden.id}`);
  } finally {
    for (const item of [meeting, task, locked]) await api('DELETE', `/api/calendar/events/${item.id}`).catch(() => {});
    // The next files expect the administrator: Alex's sign-in in the app ends.
    const [, alex] = await people();
    const { data } = await alex('GET', '/api/devices');
    for (const { id } of data?.devices?.filter(d => !d.current) ?? []) await alex('DELETE', `/api/devices/${id}`);
    await device.close();
  }
});
