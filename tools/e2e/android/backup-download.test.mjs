// 28-17 agent part (0.28.0, F9): in the app a backup downloads through
// Android's download manager by a backup-archive ticket, without the session
// cookie: the download manager is another app. The stack's nginx log
// (tools/e2e/stack.sh) shows each ticket request and whether a Cookie header
// came. An address that needs the session, as a page of a server before 0.28
// passes, is refused by the app and never fetched.
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

test('[28-17] a backup downloads in the app through its ticket, without the session cookie; an address needing the session is refused', { timeout: 900_000 }, async () => {
  const { device, page } = await openApp();
  const saved = [];
  try {
    // A ready backup whose recovery password was shown, as Settings → Backup leaves it.
    const created = await api(page, 'POST', '/api/backup/jobs', { sections: 'contacts' });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const id = created.body.job.id;
    let job = created.body.job;
    for (let attempt = 0; job.status !== 'ready' && attempt < 120; attempt++) {
      await sleep(1000);
      job = (await api(page, 'GET', `/api/backup/jobs/${id}`)).body.job;
    }
    assert.equal(job.status, 'ready');
    assert.equal((await api(page, 'POST', `/api/backup/jobs/${id}/recovery-password/reveal`, {})).status, 200);

    // A page before 0.28 passes the session download; the app refuses it.
    const sessionPath = `/api/backup/jobs/${id}/download`;
    const before = listDownloads();
    const accessBefore = readFileSync(`${stackState()}/log/nginx-access.log`, 'utf8').length;
    await download(page, sessionPath, `refused-${id}.unihub`);

    const ticket = await api(page, 'POST', '/api/files/tickets', { kind: 'backup-archive', id });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    const prefix = ticketOf(ticket.body.url);
    await download(page, ticket.body.url, ticket.body.filename);

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

    // The refused address was handled first and never reached the server.
    const access = readFileSync(`${stackState()}/log/nginx-access.log`, 'utf8').slice(accessBefore);
    assert.ok(!access.includes(sessionPath), 'the app did not fetch the session download');
    assert.ok(!listDownloads().some(name => name.startsWith('refused-')), 'nothing was saved for it');
  } finally {
    for (const name of saved) adb('shell', 'rm', '-f', `'/sdcard/Download/${name}'`);
    await device.close();
  }
});
