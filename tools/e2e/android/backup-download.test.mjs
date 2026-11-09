// 28-17 agent part (0.28.0, F9): in the app a backup downloads through
// Android's download manager by a backup-archive ticket, without the session
// cookie: the download manager is another app. The stack's nginx log
// (tools/e2e/stack.sh) shows each ticket request and whether a Cookie header
// came. A page of a server before 0.28 passes the backup's address that
// needs the session (/api/backup/jobs/<id>/download; the 0.28 server answers
// it to a session as 0.27 did): the app fetches exactly that one inside its
// own process and saves it to Downloads, never through the download manager.
// Any other address needing the session is refused and never fetched.
// Run against the stack of a 0.27.x checkout (UNIHUB_E2E_INSTANCE pointing at
// it), the same case is the real pairing of this app with an older server; the
// ticket part needs a 0.28 server and runs only there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adb, answerSlowDialogs, deviceScreenshot, openApp, sleep, stackState, ticketLog, ticketOf } from '../support/android.mjs';

const evidence = process.env.UNIHUB_E2E_EVIDENCE ?? `${process.env.TMPDIR ?? '/tmp'}`;

/** The page's own API calls, with its session and CSRF token. */
function api(page, method, path, body) {
  return page.evaluate(async ([method, path, body]) => {
    const { csrfToken } = await (await fetch('/api/auth/me')).json();
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, [method, path, body]);
}

/** What the page's download does in the app (downloadFromServer in src/lib/platform.ts). */
const download = (page, url, name) => page.evaluate(([url, name]) => window.UniHubAndroid.postMessage(JSON.stringify({ type: 'download', url: new URL(url, location.href).href, name })), [url, name]);

const listDownloads = () => adb('shell', 'ls', '/sdcard/Download/').split('\n').map(line => line.trim()).filter(Boolean);

test('[28-17] a backup downloads in the app through its ticket, without the session cookie; a 0.27 page\'s backup address is saved by the app itself, any other session address is refused', { timeout: 900_000 }, async () => {
  let { device, page } = await openApp();
  // The WebView may replace its page target (a reload) while the case runs:
  // a step that finds it gone takes the current signed-in page and runs again.
  const onPage = async step => {
    for (let attempt = 0; ; attempt++) {
      try { return await step(page); } catch (error) {
        if (attempt >= 4 || !/has been closed/.test(String(error?.message))) throw error;
        await device.close().catch(() => {});
        ({ device, page } = await openApp({ restart: false }));
      }
    }
  };
  const saved = [];
  try {
    // A ready backup whose recovery password was shown, as Settings → Backup leaves it.
    const created = await onPage(current => api(current, 'POST', '/api/backup/jobs', { sections: 'contacts' }));
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const id = created.body.job.id;
    let job = created.body.job;
    for (let attempt = 0; job.status !== 'ready' && attempt < 120; attempt++) {
      await sleep(1000);
      job = (await onPage(current => api(current, 'GET', `/api/backup/jobs/${id}`))).body.job;
    }
    assert.equal(job.status, 'ready');
    assert.equal((await onPage(current => api(current, 'POST', `/api/backup/jobs/${id}/recovery-password/reveal`, {}))).status, 200);

    const sessionPath = `/api/backup/jobs/${id}/download`;
    const otherPath = `/api/backup/jobs/${id}`;
    const before = listDownloads();
    const accessBefore = readFileSync(`${stackState()}/log/nginx-access.log`, 'utf8').length;
    // Any other address needing the session is refused.
    await onPage(current => download(current, otherPath, `refused-${id}.zip`));

    // A page before 0.28 passes the session download (use-mail-account-backup,
    // BackupSettings in 0.27.x): the app saves it itself.
    const legacyName = `legacy-${id}.zip`;
    await onPage(current => download(current, sessionPath, legacyName));
    let legacy = null;
    for (let attempt = 0; attempt < 120 && !legacy; attempt++) {
      await answerSlowDialogs();
      legacy = listDownloads().find(name => !before.includes(name) && !name.startsWith('.pending') && name.startsWith(`legacy-${id}`)) ?? null;
      if (!legacy) await sleep(1000);
    }
    assert.ok(legacy, `the 0.27 page's backup is in Downloads (${listDownloads().join(', ')})`);
    saved.push(legacy);
    let legacySha = '';
    for (let attempt = 0; attempt < 60 && legacySha !== job.file_sha256; attempt++) {
      legacySha = adb('shell', 'sha256sum', `'/sdcard/Download/${legacy}'`).trim().split(/\s+/)[0];
      if (legacySha !== job.file_sha256) await sleep(1000);
    }
    assert.equal(legacySha, job.file_sha256, 'the app saved the stored archive');

    const server = await onPage(current => current.evaluate(async () => (await (await fetch('/api/version')).json()).server));
    console.log(`server ${server}`);
    if (Number(String(server).split('.')[1]) < 28) {
      const access = readFileSync(`${stackState()}/log/nginx-access.log`, 'utf8').slice(accessBefore).split('\n');
      assertSessionDownload(access, sessionPath, otherPath);
      assert.ok(!listDownloads().some(name => name.startsWith('refused-')), 'nothing was saved for the refused address');
      return;
    }

    const ticket = await onPage(current => api(current, 'POST', '/api/files/tickets', { kind: 'backup-archive', id }));
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    const prefix = ticketOf(ticket.body.url);
    await onPage(current => download(current, ticket.body.url, ticket.body.filename));

    // The download manager fetches the ticket alone: no Cookie header, the whole archive.
    let requests = [];
    for (let attempt = 0; attempt < 120 && !requests.some(request => request.status === 200 || request.status === 206); attempt++) {
      await sleep(1000);
      requests = ticketLog().filter(request => request.ticket === prefix);
    }
    console.log(`ticket requests: ${JSON.stringify(requests)}`);
    assert.ok(requests.length > 0, 'the download manager used the ticket');
    assert.ok(requests.every(request => request.cookie === 'absent'), 'no request carried the session cookie');
    assert.ok(requests.every(request => request.status === 200 || request.status === 206), 'every request got the archive');

    let file = null;
    for (let attempt = 0; attempt < 120 && !file; attempt++) {
      await answerSlowDialogs();
      file = listDownloads().find(name => !before.includes(name) && !name.startsWith('.pending') && name.startsWith(ticket.body.filename.replace(/\.[^.]+$/, ''))) ?? null;
      if (!file) await sleep(1000);
    }
    assert.ok(file, `the archive is in Downloads (${listDownloads().join(', ')})`);
    saved.push(file);
    let sha = '';
    for (let attempt = 0; attempt < 60 && sha !== job.file_sha256; attempt++) {
      sha = adb('shell', 'sha256sum', `'/sdcard/Download/${file}'`).trim().split(/\s+/)[0];
      if (sha !== job.file_sha256) await sleep(1000);
    }
    assert.equal(sha, job.file_sha256, 'the downloaded archive is the stored one');
    deviceScreenshot(`${evidence}/android-backup-download.png`);

    assertSessionDownload(readFileSync(`${stackState()}/log/nginx-access.log`, 'utf8').slice(accessBefore).split('\n'), sessionPath, otherPath);
    assert.ok(!listDownloads().some(name => name.startsWith('refused-')), 'nothing was saved for it');
  } finally {
    for (const name of saved) adb('shell', 'rm', '-f', `'/sdcard/Download/${name}'`);
    await device.close();
  }
});

// The session download came from the app's own process (its user agent), not
// from Android's download manager, which would send the WebView's; the
// refused address never reached the server.
function assertSessionDownload(access, sessionPath, otherPath) {
  const fetched = access.filter(line => line.includes(`"GET ${sessionPath} `));
  console.log(`session download requests: ${JSON.stringify(fetched)}`);
  assert.equal(fetched.length, 1, 'the app fetched the session download once');
  assert.match(fetched[0], /" 200 \d+ /, 'and got the archive');
  // The app's own requests say only UniHubAndroid/<version> (<code>); the
  // WebView's agent, which the download manager would send, starts with
  // Mozilla and names the bridge.
  assert.match(fetched[0], /"UniHubAndroid\/[^" ]+ \(\d+\)" "[^"]*"$/, 'from its own process');
  assert.ok(!fetched[0].includes('UniHubBridge'), 'not from the download manager');
  assert.ok(!access.some(line => line.includes(`"GET ${otherPath} `)), 'the app did not fetch the other session address');
}
