import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { createGroup, effectiveOf, seededId, setRules, sweep } from './organisation-helpers.ts';

// 30-06: the Music page, then Recordings and Music as a whole, turned off for
// blair's group. For blair they leave the navigation and the start page, a
// direct visit says why, the switch in Settings is greyed, and the server
// refuses; alex, not in the group, keeps both.

test('[30-06] the Music page and then Recordings turned off for blair\'s group leave navigation, start page and a direct visit, with the reason', { session: 'blair', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  const blair = await signIn('blair');
  const settings = ok(await blair<{ settings: Record<string, { value: unknown }> }>('GET', '/api/settings/values'), 'blair settings').settings;
  const startPage = settings.default_start_page.value;
  // The rail on a wide window; the bottom bar or the list of More on a phone.
  const pageLink = (name: string) => screen.getByRole('link', name, { exact: true, visible: true });
  try {
    ok(await blair('PUT', '/api/settings/values', { values: { default_start_page: 'music' } }), 'Music as the start page');
    const group = await createGroup('No music', [await seededId('blair')]);
    await app.open('/more');
    await expect(pageLink('Music').first()).toBeVisible();

    await setRules({ 'pages.music': 'forbidden' }, { groupId: group.id });
    const music = (await effectiveOf('blair')).policies['pages.music'];
    expect(music.allowed).toBe(false);
    expect((await effectiveOf('alex')).policies['pages.music'].allowed, 'alex is not in the group').toBe(true);

    await app.open('/more');
    await expect(pageLink('Recordings').first()).toBeVisible();
    await expect(pageLink('Music')).toHaveCount(0);
    // The start page falls back to the first page of the navigation.
    await app.open('/');
    await expect(browser).toHaveURL(/\/(mail|dashboard|calendar|todo|contacts|recordings)/);
    await app.open('/music');
    await expect(screen.getByText('Music is not available', { exact: true })).toBeVisible();
    await expect(screen.getByText(music.reason ?? 'the server gave no reason').first()).toBeVisible();
    await app.open('/settings?section=pages');
    await expect(screen.getByRole('switch', 'Music: show in navigation')).toBeDisabled();
    await expect(screen.getByRole('switch', 'Recordings: show in navigation')).toBeEnabled();

    await setRules({ 'modules.recordings': 'forbidden' }, { groupId: group.id });
    await app.open('/more');
    await expect(pageLink('Recordings')).toHaveCount(0);
    await expect(pageLink('Music')).toHaveCount(0);
    await app.open('/recordings');
    await expect(screen.getByText(/is not available$/)).toBeVisible();
    const refused = await pageApi<{ code?: string }>(browser, 'GET', '/api/recordings');
    expect(refused.status, 'the server refuses the module, not only the page').toBe(403);
    expect((await (await signIn('alex'))('GET', '/api/recordings')).status, 'alex keeps Recordings').toBe(200);
    await app.open('/settings?section=pages');
    await expect(screen.getByRole('switch', 'Recordings and Music: enabled')).toBeDisabled();
  } finally {
    await sweep();
    ok(await blair('PUT', '/api/settings/values', { values: { default_start_page: startPage } }), 'restore the start page');
  }
});
