// B-33 (0.27.1): "Open in app" (unihub://connect?server=…) on a closed app
// sometimes showed the app's own "Connect to your UniHub" screen instead of
// the question to connect to that server. A minute or two after a phone
// starts, Android applies its theme overlays, a change of every app's
// resources (assets paths) that an app cannot take itself, so it recreated
// the activity from its saved state, and a recreated activity never asked
// about the link. Now the question survives the recreation, and a link that
// was answered is not asked again.
//
// A font size change recreates the activity on demand, as the overlays did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE, adb, answerSlowDialogs, screenNodes, sleep } from '../support/android.mjs';

// Another server than the stack's: the question does not contact it.
const LINK = `unihub://connect?server=${encodeURIComponent('http://10.0.2.2:9')}`;
const QUESTION = 'Connect to 10.0.2.2?';
const COLD_STARTS = Number(process.env.UNIHUB_E2E_CONNECT_STARTS ?? 10);

const savedServer = () => adb('shell', `run-as ${PACKAGE} cat shared_prefs/server.xml 2>/dev/null; true`);
const forgetServer = () => adb('shell', `run-as ${PACKAGE} rm -f shared_prefs/server.xml`);
function restoreServer(xml) {
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('shell', `echo ${Buffer.from(xml).toString('base64')} | base64 -d > /data/local/tmp/unihub-server.xml`);
  adb('shell', `run-as ${PACKAGE} mkdir -p shared_prefs && run-as ${PACKAGE} cp /data/local/tmp/unihub-server.xml shared_prefs/server.xml`);
}

/** Waits until check(nodes) holds, answering a slow emulator's "isn't responding" dialogs. */
async function screenUntil(what, check, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let texts = [];
  while (Date.now() < until) {
    await answerSlowDialogs();
    const nodes = screenNodes();
    texts = nodes.map(n => n.text).filter(Boolean);
    if (check(nodes)) return nodes;
    await sleep(1000);
  }
  throw new Error(`${what} within ${timeoutMs / 1000} s; the screen showed: ${texts.slice(0, 20).join(' | ')}`);
}
const questionShown = nodes => nodes.some(n => n.text === QUESTION && n.pkg === PACKAGE);

async function cancelQuestion() {
  const cancel = screenNodes().find(n => /^cancel$/i.test(n.text) && n.pkg === PACKAGE);
  assert.ok(cancel, 'the question has Cancel');
  adb('shell', 'input', 'tap', `${cancel.x}`, `${cancel.y}`);
  await screenUntil('the question closed', nodes => !questionShown(nodes), 30_000);
}

function coldStartFromLink() {
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('shell', `am start -a android.intent.action.VIEW -d '${LINK}' ${PACKAGE}`);
}

/** Changes the font size, which Android applies by recreating the activity. */
async function recreate() {
  const created = () => (adb('logcat', '-d', '-b', 'events').match(/[aw]m_on_create_called: \[\d+,io\.github\.mrksrus\.unihub\.MainActivity/g) ?? []).length;
  const before = created();
  const scale = adb('shell', 'settings', 'get', 'system', 'font_scale').trim() === '1.15' ? '1.0' : '1.15';
  adb('shell', 'settings', 'put', 'system', 'font_scale', scale);
  for (let i = 0; i < 30 && created() === before; i++) await sleep(1000);
  assert.ok(created() > before, 'Android recreated the activity');
  // The old activity's question window is gone by then.
  await sleep(3000);
}

async function eachState(t, run) {
  // The first run (no server saved yet) and a phone already using another server.
  const saved = savedServer();
  const fontScale = adb('shell', 'settings', 'get', 'system', 'font_scale').trim();
  try {
    forgetServer();
    await t.test('without a saved server', run);
    if (saved.includes('origin')) {
      restoreServer(saved);
      await t.test('with the stack as the saved server', run);
    }
  } finally {
    if (/^null$|^$/.test(fontScale)) adb('shell', 'settings', 'delete', 'system', 'font_scale');
    else adb('shell', 'settings', 'put', 'system', 'font_scale', fontScale);
    adb('shell', 'am', 'force-stop', PACKAGE);
    if (saved.includes('origin')) restoreServer(saved);
  }
}

test(`[B-33] every cold start from a connect link asks about its server (${COLD_STARTS} starts)`, { timeout: COLD_STARTS * 120_000 + 120_000 }, async t => {
  await eachState(t, async () => {
    for (let start = 1; start <= COLD_STARTS; start++) {
      coldStartFromLink();
      await screenUntil(`start ${start}: the question to connect`, questionShown);
      await cancelQuestion();
    }
  });
});

test('[B-33] the question to connect survives Android recreating the app, and an answered one does not come back', { timeout: 600_000 }, async t => {
  await eachState(t, async () => {
    adb('logcat', '-c', '-b', 'events');
    coldStartFromLink();
    await screenUntil('the question to connect', questionShown);
    await recreate();
    await screenUntil('the question again after the recreation', questionShown);
    await cancelQuestion();
    await recreate();
    assert.equal(questionShown(screenNodes()), false, 'Cancel was the answer: the recreated app does not ask again');
  });
});
