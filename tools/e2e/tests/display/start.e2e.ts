import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { onlyOn } from '../support/ui.ts';

// Records every text the page shows from its first render, before the app's scripts run.
function recordTexts() {
  const w = window as unknown as { __startTexts: string[] };
  w.__startTexts = [];
  const note = () => {
    const text = document.getElementById('root')?.innerText.replace(/\s+/g, ' ').trim() ?? '';
    if (text && w.__startTexts.length < 400 && w.__startTexts[w.__startTexts.length - 1] !== text) w.__startTexts.push(text.slice(0, 200));
  };
  new MutationObserver(note).observe(document, { subtree: true, childList: true, characterData: true });
}

// B-21: a cold start of the app showed several screens with only text before the mail:
// "Loading UniHub…", a bare "Loading…" while the start page's code loaded, "Opening
// UniHub…" over a half-built bottom bar, then "No mail account yet" while the accounts
// were still loading. Now one "Opening UniHub…" screen stays until the Mail page shows,
// which then says "Loading mail…" until its list is there; it never claims there is no
// account. The accounts answer is slowed so the gap is always there.
test('[B-21] a cold start shows one start screen, then the mail, never "No mail account yet"', { session: 'admin', timeout: 180_000 }, async ({ app, browser }) => {
  await onlyOn(browser, 'android-app', 'phone');
  await browser.route(/\/api\/mail\/accounts$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fallback();
  });
  await browser.addInitScript(recordTexts);
  await app.open('/');
  await expect(browser.locator('ul[aria-label^="Inbox"] li').first()).toBeVisible({ timeout: 60_000 });
  const texts = await browser.evaluate(() => (window as unknown as { __startTexts: string[] }).__startTexts);
  const beforeMail = texts.slice(0, texts.findIndex((text) => text.includes('Loading mail…')) + 1 || texts.length);
  console.log(`start screens: ${JSON.stringify(beforeMail)}`);
  expect(texts.some((text) => text.includes('No mail account yet')), 'no false "No mail account yet"').toBe(false);
  expect(texts.some((text) => text.includes('Loading UniHub…')), 'no separate "Loading UniHub…" screen').toBe(false);
  expect(beforeMail.filter((text) => text === 'Loading…'), 'no bare "Loading…" screen').toEqual([]);
  expect(beforeMail.some((text) => text.includes('Opening UniHub…'))).toBe(true);
});
