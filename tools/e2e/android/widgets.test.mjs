// 32-08 to 32-11 (emulator half), D69: the Calendar and ToDo widgets on the
// home screen of the real app. Both are put there through Android's own "Add
// to home screen" dialog and read from the launcher's screen as a person sees
// them. A tick on the ToDo widget reaches the server, also while the app is
// locked (the app lock does not hide the widgets, the notification detail
// does); the least detail "none" leaves times and "Event" without ticks;
// signing out and another person's sign-in empty them. Their look (W-01 to
// W-05 of docs/UI_ACCEPTANCE.md) is the second test: each widget alone on the
// screen at three sizes, light and dark, with its states, pictured for the
// eye; the tick's 48dp target and the rows' way into UniHub are measured.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addPerson, resetPeople } from '../support/people.mjs';
import {
  PACKAGE, adb, answerPromptWithPin, deviceScreenshot, openApp, resetAppLock, screenNodes, setDevicePin, setPolicies, sleep, stackSession, tapNative, touch,
  waitForUnlockPrompt,
} from '../support/android.mjs';

const evidence = process.env.UNIHUB_E2E_EVIDENCE ?? `${process.env.TMPDIR ?? '/tmp'}`;

const run = Date.now().toString(36);
const MEETING = `Widget meeting ${run}`;
const TASK = `Widget task ${run}`;
const LOCKED_TASK = `Locked task ${run}`;

/** The app in front, as Android requires of an app that asks to pin a widget. */
async function toFront() {
  adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  for (const end = Date.now() + 60_000; Date.now() < end && !adb('shell', 'dumpsys window | grep mCurrentFocus').includes(PACKAGE); await sleep(1000));
}

/** Waits until UniHub's page, not a widget's host, is in front. */
async function inFront(what) {
  for (const end = Date.now() + 60_000; Date.now() < end; await sleep(1000)) if (adb('shell', 'dumpsys window | grep mCurrentFocus').includes(`${PACKAGE}.MainActivity`)) return;
  assert.fail(what);
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
    deviceScreenshot(`${evidence}/android-widget-home-screen.png`);

    // A tick on the home screen: done on the server, gone from the widget.
    await tapNative(new RegExp(`^Mark done: ${TASK}$`));
    for (const end = Date.now() + 60_000; Date.now() < end && await taskStatus(api, task.id) !== 'done'; await sleep(1000));
    assert.equal(await taskStatus(api, task.id), 'done', 'the tick reached the server');
    await home(nodes => !shows(TASK)(nodes) && shows(LOCKED_TASK)(nodes), 'the ticked task left the widget');

    // A tap on a task's title, from the launcher: UniHub comes to the front on ToDo.
    await tapNative(new RegExp(`^${LOCKED_TASK}$`));
    await inFront('a tap on a task opens UniHub');
    await page.waitForURL(url => url.pathname === '/todo', { timeout: 60_000 });

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

test('[32-08] the widgets\' look at three sizes, light and dark, and their states; the tick is a 48dp target apart from the title; a row opens UniHub', { timeout: 1_800_000 }, async () => {
  // Whoever the test before left signed in goes: its own person with their account, the administrator by their device.
  await resetPeople();
  await resetAppLock();
  const person = await addPerson('widget-look');
  const api = await person.session();
  const density = Number(/(\d+)\s*$/.exec(adb('shell', 'wm', 'density').trim())[1]) / 160;
  const [, width, height] = /(\d+)x(\d+)\s*$/.exec(adb('shell', 'wm', 'size').trim()).map(Number);
  // In dp: about 3 by 2 cells of a phone's home screen, about 4 by 4, and the whole screen.
  const wide = Math.floor(width / density) - 16;
  const sizes = { small: [Math.min(250, wide), 190], medium: [Math.min(330, wide), 320], full: [wide, Math.floor(height / density) - 140] };
  const wasNight = /yes/.test(adb('shell', 'cmd', 'uimode', 'night'));
  const reversed = adb('reverse', '--list').split('\n').map(line => line.trim().split(/\s+/).slice(1)).filter(ports => ports.length === 2);
  /** One widget alone on the screen at a size (the debug app's TestWidgetHost), fetched anew; answers its nodes once `check` holds. */
  const hosted = (kind, size, check, what) => {
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.TestWidgetHost`, '--es', 'kind', kind, '--ei', 'width', `${size[0]}`, '--ei', 'height', `${size[1]}`);
    return home(check, what);
  };
  const shot = name => deviceScreenshot(`${evidence}/android-widget-${name}.png`);
  const day = (offset, hours = 0, minutes = 0) => {
    const date = new Date(Date.now() + offset * 86_400_000);
    date.setUTCHours(hours, minutes, 0, 0);
    return date.toISOString();
  };
  const create = async body => {
    const { status, data } = await api('POST', '/api/calendar/events', { reminders: null, ...body });
    assert.equal(status, 200, JSON.stringify(data));
  };
  // The first row of each widget; the person is this test's own, so the titles need no run id.
  const RELEASE = 'Release day';
  const CONTRACT = 'Send the signed contract';

  adb('shell', 'appwidget', 'grantbind', '--package', PACKAGE, '--user', '0');
  const { device, page } = await openApp({ email: person.email });
  try {
    adb('shell', 'cmd', 'uimode', 'night', 'no');
    await hosted('agenda', sizes.small, shows('Nothing in the next 14 days'), 'the empty Calendar widget');
    shot('agenda-empty');
    await hosted('tasks', sizes.small, shows('No open tasks'), 'the empty ToDo widget');
    shot('tasks-empty');

    await create({ title: CONTRACT, start_time: day(-1, 9), end_time: day(-1, 9, 30) });
    await create({ title: RELEASE, start_time: day(0), end_time: day(1), all_day: true, color: '#0f766e' });
    await create({ title: 'Design review', start_time: day(1, 9, 30), end_time: day(1, 10, 15) });
    await create({ title: 'Quarterly planning with the whole support team and the guests from the partner office', start_time: day(1, 14), end_time: day(1, 15, 30), color: '#db2777' });
    await create({ title: 'Dentist', start_time: day(3, 11), end_time: day(3, 12), color: '#7c3aed' });
    await create({ title: 'Team offsite', start_time: day(6), end_time: day(7), all_day: true, color: '#0f766e' });
    await create({ title: 'Book train tickets', is_todo_only: true });
    await create({ title: 'Write up the notes from the customer workshop and send them round to everyone who came', is_todo_only: true });
    await create({ title: 'Renew the domain', is_todo_only: true });

    for (const theme of ['light', 'dark']) {
      adb('shell', 'cmd', 'uimode', 'night', theme === 'dark' ? 'yes' : 'no');
      for (const [name, size] of Object.entries(sizes)) {
        await hosted('agenda', size, shows(RELEASE), `the Calendar widget, ${name}, ${theme}`);
        shot(`agenda-${name}-${theme}`);
        await hosted('tasks', size, shows(CONTRACT), `the ToDo widget, ${name}, ${theme}`);
        shot(`tasks-${name}-${theme}`);
      }
    }

    // The tick at the smallest size: 48dp each way, beside the title and not on it, no two on each other.
    const nodes = await hosted('tasks', sizes.small, shows(CONTRACT), 'the ToDo widget for its measures');
    const ticks = nodes.filter(node => /^Mark done: /.test(node.desc)).sort((a, b) => a.y - b.y);
    const title = nodes.find(node => node.text === CONTRACT);
    const tick = ticks.find(node => node.desc === `Mark done: ${CONTRACT}`);
    assert.ok(ticks.length >= 2 && tick, 'the tasks have their ticks');
    // The widget's edge may cut the last row.
    for (const node of ticks.slice(0, -1)) assert.ok(node.w >= 48 * density - 1 && node.h >= 48 * density - 1, `a tick of ${node.w} by ${node.h} px is under 48dp (${48 * density} px)`);
    assert.ok(tick.x + tick.w / 2 <= title.x - title.w / 2, 'the tick ends where the title begins');
    ticks.slice(1).forEach((node, index) => assert.ok(node.y - node.h / 2 >= ticks[index].y + ticks[index].h / 2 - 1, 'no tick lies on the next'));

    // A task's title and an event open UniHub at their page.
    adb('shell', 'input', 'tap', `${title.x}`, `${title.y}`);
    await inFront('a tap on a task opens UniHub');
    await page.waitForURL(url => url.pathname === '/todo', { timeout: 60_000 });
    const event = (await hosted('agenda', sizes.small, shows(RELEASE), 'the Calendar widget for its tap')).find(node => node.text === RELEASE);
    adb('shell', 'input', 'tap', `${event.x}`, `${event.y}`);
    await inFront('a tap on an event opens UniHub');
    await page.waitForURL(url => url.pathname === '/calendar', { timeout: 60_000 });

    // Without a connection the rows stay, with when they were fetched. The app is stopped first:
    // a connection it still holds open would go on working without the port.
    await device.close();
    for (const [port] of reversed) adb('reverse', '--remove', port);
    adb('shell', 'am', 'force-stop', PACKAGE);
    await hosted('tasks', sizes.small, nodes => shows(CONTRACT)(nodes) && nodes.some(node => /^No connection\. Updated \d\d:\d\d$/.test(node.text)), 'the ToDo widget without a connection');
    shot('tasks-no-connection');
    for (const [port, to] of reversed) adb('reverse', port, to);

    // The least detail: times, "Event" and "Task", faint circles, and the reason under the rows.
    await setPolicies({ 'notifications.detail': 'none' });
    const hiddenNote = nodes => nodes.some(node => node.text === 'Titles hidden, as in notifications');
    await hosted('agenda', sizes.small, nodes => shows('Event')(nodes) && hiddenNote(nodes), 'the Calendar widget with titles hidden');
    shot('agenda-titles-hidden');
    const plain = await hosted('tasks', sizes.small, nodes => shows('Task')(nodes) && hiddenNote(nodes), 'the ToDo widget with titles hidden');
    assert.ok(!plain.some(node => /^Mark done:/.test(node.desc)), 'no tick with titles hidden');
    shot('tasks-titles-hidden');
    await setPolicies({ 'notifications.detail': 'full' });

    // Signed out: one line and the way in.
    for (const { id } of (await api('GET', '/api/devices')).data.devices.filter(entry => !entry.current)) assert.equal((await api('DELETE', `/api/devices/${id}`)).status, 200);
    await hosted('tasks', sizes.small, nodes => shows('Sign in to UniHub to see this')(nodes) && shows('Open UniHub')(nodes), 'the signed-out ToDo widget');
    shot('tasks-signed-out');
  } finally {
    for (const [port, to] of reversed) adb('reverse', port, to);
    adb('shell', 'cmd', 'uimode', 'night', wasNight ? 'yes' : 'no');
    await setPolicies({ 'notifications.detail': 'full' });
    await device.close().catch(() => {});
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  }
});
