// 32-08 to 32-11 (emulator half), D69: the Calendar and ToDo widgets on the
// home screen of the real app. Both are put there through Android's own "Add
// to home screen" dialog and read from the launcher's screen as a person sees
// them. A tick on the ToDo widget reaches the server, also while the app is
// locked (the app lock does not hide the widgets, the notification detail
// does); the least detail "none" leaves times and "Event" without ticks;
// signing out and another person's sign-in empty them. Their look is checked
// elsewhere.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addPerson, resetPeople } from '../support/people.mjs';
import {
  PACKAGE, adb, answerPromptWithPin, openApp, resetAppLock, screenNodes, setDevicePin, setPolicies, sleep, stackSession, tapNative, touch,
  waitForUnlockPrompt,
} from '../support/android.mjs';

const run = Date.now().toString(36);
const MEETING = `Widget meeting ${run}`;
const TASK = `Widget task ${run}`;
const LOCKED_TASK = `Locked task ${run}`;

/** The app in front, as Android requires of an app that asks to pin a widget. */
async function toFront() {
  adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  for (const end = Date.now() + 60_000; Date.now() < end && !adb('shell', 'dumpsys window | grep mCurrentFocus').includes(PACKAGE); await sleep(1000));
}

/** Asks the launcher to place a widget and confirms its dialog. */
async function place(kind) {
  await toFront();
  adb('shell', 'am', 'broadcast', '-n', `${PACKAGE}/.TestWidgets`, '--es', 'pin', kind);
  await tapNative(/^add( to home screen)?$/i, { timeoutMs: 60_000 });
  await sleep(2000);
}

/** The home screen after the widgets fetched again (the job the app schedules every 30 minutes, run now). */
async function refreshed() {
  // Home on the home screen would turn to its first page, away from the widgets.
  if (!/launcher/i.test(adb('shell', 'dumpsys window | grep mCurrentFocus'))) adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  try {
    adb('shell', 'cmd', 'jobscheduler', 'run', '-f', PACKAGE, '70');
  } catch {
    // A force stop (resetAppLock) cancelled the job: the app opened and left fetches and schedules it again.
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
    await sleep(5000);
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  }
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
});

after(async () => {
  await setPolicies({ 'notifications.detail': 'full' });
  await resetAppLock();
  // Removing the test's own person ends their sign-in in the app; the next files expect the administrator.
  await resetPeople();
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
  // First in the administrator's own order, so the widget shows them above the seeded tasks.
  const first = async id => {
    const { data } = await api('GET', '/api/widgets');
    const top = data.tasks[0].id;
    if (top !== id) assert.equal((await api('PUT', `/api/calendar/events/${id}/position`, { before: top, after: null })).status, 200);
  };
  await first(locked.id);
  await first(task.id);

  const { device, page } = await openApp();
  try {
    // The launcher may put each on a page of its own: each is read where it was put, the ToDo widget last.
    await place('agenda');
    await refreshed();
    await home(shows(MEETING), 'the Calendar widget shows the meeting');
    await place('tasks');
    await refreshed();
    await home(shows(TASK), 'the ToDo widget shows the task');

    // A tick on the home screen: done on the server, gone from the widget.
    await tapNative(new RegExp(`^Mark done: ${TASK}$`));
    for (const end = Date.now() + 60_000; Date.now() < end && await taskStatus(api, task.id) !== 'done'; await sleep(1000));
    assert.equal(await taskStatus(api, task.id), 'done', 'the tick reached the server');
    await home(nodes => !shows(TASK)(nodes) && shows(LOCKED_TASK)(nodes), 'the ticked task left the widget');

    // The whole app locked: the widgets keep their titles and the tick still works.
    await toFront();
    await page.goto(new URL('/settings?section=app-lock', page.url()).href);
    await touch(page, page.getByText('Whole app', { exact: true }));
    await waitForUnlockPrompt();
    await answerPromptWithPin();
    await page.getByLabel('Ask again').selectOption({ label: 'Every time UniHub opens' }, { timeout: 5000 }).catch(async () => {
      await touch(page, page.getByRole('combobox', { name: 'Ask again' }));
      await touch(page, page.getByRole('option', { name: 'Every time UniHub opens' }));
    });
    await sleep(2000);
    await refreshed();
    await home(shows(LOCKED_TASK), 'the locked app\'s widget keeps its titles');
    await tapNative(new RegExp(`^Mark done: ${LOCKED_TASK}$`));
    for (const end = Date.now() + 60_000; Date.now() < end && await taskStatus(api, locked.id) !== 'done'; await sleep(1000));
    assert.equal(await taskStatus(api, locked.id), 'done', 'the tick reached the server while the app was locked');

    // The least detail "none": tasks without titles and without a tick.
    const hidden = await create({ title: `Hidden task ${run}`, is_todo_only: true });
    await setPolicies({ 'notifications.detail': 'none' });
    await refreshed();
    const plain = await home(nodes => shows('Task')(nodes) && !nodes.some(node => /^Mark done:/.test(node.desc)), 'titles and ticks hidden at detail none');
    assert.ok(!plain.some(node => node.text.includes(hidden.title)), 'no title at detail none');
    await setPolicies({ 'notifications.detail': 'full' });

    // Signed out (the app's session ended): the widget empties, with "Open UniHub".
    // The page's handle goes first: a second one to the same app keeps the next sign-in from finishing.
    await device.close();
    await resetAppLock();
    await refreshed();
    const out = await home(shows('Sign in to UniHub to see this'), 'the widget says to sign in');
    assert.ok(out.some(node => node.text === 'Open UniHub') && !out.some(node => /^Mark done:/.test(node.desc)));

    // Another person signs in: their own task shows, none of the administrator's items.
    const person = await addPerson('widgets');
    const theirTask = `Their task ${run}`;
    const created = await (await person.session())('POST', '/api/calendar/events', { title: theirTask, is_todo_only: true, reminders: null });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const other = await openApp({ email: person.email });
    await other.device.close();
    await refreshed();
    const theirs = await home(shows(theirTask), 'the other person\'s widget shows their task');
    assert.ok(!theirs.some(node => [MEETING, LOCKED_TASK].includes(node.text) || node.text === hidden.title), 'nothing of the administrator\'s');
    await api('DELETE', `/api/calendar/events/${hidden.id}`);
  } finally {
    for (const item of [meeting, task, locked]) await api('DELETE', `/api/calendar/events/${item.id}`).catch(() => {});
    await device.close().catch(() => {});
  }
});
