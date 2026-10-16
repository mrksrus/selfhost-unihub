// Pinned interface behaviour from PROJECT-PREFERENCES.md, checked in the real
// built frontend: content rows stay in view (P-07), context panels fold
// independently and remember it (P-08), keyboard focus is visible and returns
// (P-12), the theme is painted before the app runs and follows the choice
// (P-02), and touch targets are big enough and never overlap (P-11).
import type { Page } from '@playwright/test';
import { RICH_TASK, TASKS } from '../support/fixtures.ts';
import { touchViolations } from '../support/geometry.ts';
import { expectOnlyKnown, KNOWN_DEFECTS } from '../support/known-defects.ts';
import { expect, pointerIsCoarse, test, VIEWPORTS } from '../support/test.ts';

/**
 * Row content the page body cannot show: anything past the body's visible width
 * (cut off, or reachable only by scrolling sideways), and sideways scrolling itself.
 */
async function clippedRows(page: Page, rows: string, name: string) {
  return page.locator(rows).evaluateAll((items, name) => {
    const problems: string[] = [];
    const bodies = new Set<Element>();
    for (const row of items) {
      const body = row.closest('.overflow-y-auto') ?? document.scrollingElement!;
      bodies.add(body);
      const visible = body.getBoundingClientRect();
      const right = Math.min(visible.right, innerWidth);
      const title = row.querySelector('p, h3, span')?.textContent?.trim() ?? '';
      const past = [...row.querySelectorAll('*')].filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > right + 1;
      });
      if (past.length) {
        const furthest = Math.max(...past.map(element => element.getBoundingClientRect().right));
        problems.push(`${name} row "${title}": content runs to ${Math.round(furthest)} px, past the visible page edge at ${Math.round(right)} px`);
      }
    }
    for (const body of bodies) {
      if (body.scrollWidth > body.clientWidth + 1) problems.push(`${name} page body scrolls sideways by ${body.scrollWidth - body.clientWidth} px`);
    }
    return problems;
  }, name);
}

test.describe('P-07 content rows stay in view', () => {
  for (const [width, viewport] of Object.entries(VIEWPORTS)) {
    test.describe(width, () => {
      test.use(viewport);

      test(`ToDo rows show everything they hold (${width})`, async ({ page, open }) => {
        await open('/todo');
        for (const label of ['Overdue', 'Today', 'Later', 'No date']) {
          await expect(page.locator('section').filter({ has: page.getByText(label, { exact: true }) }).first()).toBeVisible();
        }
        for (const task of TASKS) await expect(page.getByText(task.title, { exact: true })).toBeVisible();
        await expect(page.getByText(RICH_TASK.description)).toBeVisible();
        await expect(page.getByText('planning-notes.pdf')).toBeVisible();
        for (const subtask of RICH_TASK.subtasks) await expect(page.getByRole('checkbox', { name: subtask.title })).toBeVisible();
        // Nothing in a row folds: the only disclosure a row may carry is its menu.
        await expect(page.locator('li [aria-expanded]:not([aria-haspopup="menu"])')).toHaveCount(0);
        await expect(page.locator('li details, li [data-state="closed"][aria-controls]:not([aria-haspopup])')).toHaveCount(0);
      });

      test(`ToDo rows fit their list (${width})`, async ({ page, open }) => {
        await open('/todo');
        expectOnlyKnown(await clippedRows(page, 'section > ul > li', 'ToDo'), width === 'phone' ? [KNOWN_DEFECTS.todoRowClipped] : []);
      });
    });
  }

  test.describe('phone', () => {
    test.use(VIEWPORTS.phone);
    test('Recordings rows show title, details, chords and tags, and fit (phone)', async ({ page, open }) => {
      await open('/recordings');
      await expect(page.getByText('Morning idea about the garden layout')).toBeVisible();
      await expect(page.getByText('Raised beds along the fence, herbs near the door.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'garden', exact: true })).toBeVisible();
      await expect(page.getByText('G  D  Em  C', { exact: false })).toBeVisible();
      const chords = page.locator('pre, [class*="font-mono"]').filter({ hasText: 'Em' }).first();
      await expect(chords).toHaveCSS('font-family', /JetBrains Mono/);
      await expect(page.locator('li [aria-expanded]:not([aria-haspopup="menu"])')).toHaveCount(0);
      expectOnlyKnown(await clippedRows(page, 'ul > li:has(button[aria-label^="Play"])', 'Recordings'), []);
    });
  });
});

test.describe('P-08 context panels fold independently and remember it', () => {
  test.use(VIEWPORTS.wide);

  test('Mail panel folds, survives reload and page changes, and does not fold Contacts', async ({ page, open, settle }) => {
    const mailPanel = page.getByRole('complementary', { name: 'Accounts and folders' });
    const scope = page.getByRole('button', { name: 'All accounts', exact: true }).and(page.locator('[aria-haspopup="dialog"]'));
    await open('/mail');
    await expect(mailPanel).toBeVisible();

    await mailPanel.getByRole('button', { name: 'Hide panel' }).click();
    await expect(mailPanel).toHaveCount(0);
    // P-12: "Hide panel" moves focus to the scope button that now opens the panel.
    await expect(scope).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('unihub:panel:mail'))).toBe('true');

    await page.reload();
    await settle();
    await expect(mailPanel).toHaveCount(0);

    await page.getByRole('link', { name: 'Contacts' }).click();
    await settle();
    await expect(page.getByRole('complementary', { name: 'Contact lists' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('unihub:panel:contacts'))).toBeNull();

    await page.getByRole('link', { name: /^Mail/ }).click();
    await settle();
    await expect(mailPanel).toHaveCount(0);

    // Folded, the scope button opens the panel as a sheet; closing returns focus to it.
    await scope.click();
    const sheet = page.getByRole('dialog', { name: 'Accounts and folders' });
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(scope).toBeFocused();

    // "Keep panel open" brings the column back and focus lands on its fold button.
    await scope.click();
    await sheet.getByRole('button', { name: 'Keep panel open' }).click();
    await expect(mailPanel).toBeVisible();
    await expect(mailPanel.getByRole('button', { name: 'Hide panel' })).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('unihub:panel:mail'))).toBe('false');
  });
});

test.describe('P-12 keyboard focus is visible and follows the page', () => {
  test.use(VIEWPORTS.wide);

  test('Tab order runs rail, panel, page, and every stop shows a focus ring', async ({ page, open }) => {
    await open('/mail');
    const regions: number[] = [];
    const missing: string[] = [];
    for (let step = 0; step < 45; step++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body) return null;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const ring = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
        const region = element.closest('nav[aria-label="Main"]') ? 0 : element.closest('aside') ? 1 : 2;
        const label = element.getAttribute('aria-label') || element.innerText?.trim().split('\n')[0] || element.getAttribute('placeholder') || element.tagName;
        return { ring, region, label: label.slice(0, 60), inView: box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight };
      });
      if (!stop) continue;
      regions.push(stop.region);
      if (!stop.ring) missing.push(`no focus ring on "${stop.label}"`);
      if (!stop.inView) missing.push(`"${stop.label}" is focused outside the visible page`);
    }
    expect(missing).toEqual([]);
    // Rail first, then the panel, then the page: the order follows the layout.
    expect(regions.length).toBeGreaterThan(30);
    expect(regions).toEqual([...regions].sort((a, b) => a - b));
    expect(new Set(regions)).toEqual(new Set([0, 1, 2]));
  });

  test('Ctrl+K opens search and Escape closes it', async ({ page, open }) => {
    await open('/mail');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox').or(dialog.getByRole('textbox')).first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // No trap: Tab moves on through the page afterwards.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  });
});

test.describe('P-02 theme is painted before the app runs and follows the choice', () => {
  test.use(VIEWPORTS.wide);
  // The Light Default page colour (src/index.css `--background` of `.light`).
  const LIGHT_PAGE = 'rgb(246, 247, 248)';

  /** Opens a page with the app script held back, to see what the first paint uses. */
  async function firstPaint(page: Page, path: string) {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(/\/assets\/index-[^/]+\.js$/, async route => { await held; await route.fallback(); });
    await page.goto(path, { waitUntil: 'commit' });
    await page.waitForFunction(() => document.documentElement.style.backgroundColor !== '');
    const before = await page.evaluate(() => ({
      mode: document.documentElement.classList.contains('light') ? 'light' : document.documentElement.classList.contains('dark') ? 'dark' : 'none',
      background: getComputedStyle(document.documentElement).backgroundColor,
      appMounted: !!document.getElementById('root')?.childElementCount,
    }));
    release();
    return before;
  }
  /** Mode, page colour and whether the browser bar colour (theme-color) matches the page. */
  const chrome = (page: Page) => page.evaluate(() => {
    const background = getComputedStyle(document.documentElement).backgroundColor;
    const hex = document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '';
    const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)?.slice(1).map(part => parseInt(part, 16));
    return {
      mode: document.documentElement.classList.contains('light') ? 'light' : 'dark',
      background,
      barMatchesPage: !!channels && background === `rgb(${channels.join(', ')})`,
    };
  });

  test('Dark is the default and is painted before the app script', async ({ page, settle }) => {
    const before = await firstPaint(page, '/mail');
    expect(before).toEqual({ mode: 'dark', background: 'rgb(0, 0, 0)', appMounted: false });
    await settle();
    expect(await chrome(page)).toEqual({ mode: 'dark', background: 'rgb(0, 0, 0)', barMatchesPage: true });
  });

  test.describe('stored light', () => {
    test.use({ theme: 'light', colorScheme: 'dark' });
    test('a stored Light choice is painted before the app script, whatever the OS prefers', async ({ page, settle }) => {
      // index.html paints #f5f7fa before the stylesheet's own light page colour
      // takes over; the check holds the mode, not the last channel value.
      const before = await firstPaint(page, '/mail');
      expect(before).toEqual({ mode: 'light', background: 'rgb(245, 247, 250)', appMounted: false });
      await settle();
      expect(await chrome(page)).toEqual({ mode: 'light', background: LIGHT_PAGE, barMatchesPage: true });
    });
  });

  test('Settings switches Dark, Light and System, and the choice survives a reload', async ({ page, open, settle }) => {
    await open('/settings?section=appearance');
    const themes = page.getByRole('radiogroup', { name: 'Theme' });

    await themes.getByRole('radio', { name: 'Light' }).click();
    await expect(themes.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    expect(await chrome(page)).toEqual({ mode: 'light', background: LIGHT_PAGE, barMatchesPage: true });
    await page.reload();
    await settle();
    expect(await chrome(page)).toEqual({ mode: 'light', background: LIGHT_PAGE, barMatchesPage: true });

    // System follows the OS preference, also when it changes while the page is open.
    await page.emulateMedia({ colorScheme: 'light' });
    await themes.getByRole('radio', { name: 'System' }).click();
    expect(await chrome(page)).toEqual({ mode: 'light', background: LIGHT_PAGE, barMatchesPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(async () => (await chrome(page)).mode).toBe('dark');
    expect(await chrome(page)).toEqual({ mode: 'dark', background: 'rgb(0, 0, 0)', barMatchesPage: true });

    await themes.getByRole('radio', { name: 'Dark' }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await settle();
    expect(await chrome(page)).toEqual({ mode: 'dark', background: 'rgb(0, 0, 0)', barMatchesPage: true });
  });
});

test.describe('P-11 touch targets are big enough and never overlap', () => {
  test.use(VIEWPORTS.phone);

  test('the phone layout is measured with a coarse pointer', async ({ page, open }) => {
    await open('/todo');
    expect(await pointerIsCoarse(page)).toBe(true);
  });

  test('ToDo', async ({ page, open }) => {
    await open('/todo');
    expectOnlyKnown(await touchViolations(page), []);
  });

  test('Mail list', async ({ page, open }) => {
    await open('/mail');
    expectOnlyKnown(await touchViolations(page), []);
  });

  test('Composer', async ({ page, open, settle }) => {
    await open('/mail');
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
  });

  test('Recordings', async ({ page, open }) => {
    await open('/recordings');
    expectOnlyKnown(await touchViolations(page), [KNOWN_DEFECTS.recordingTagTargets]);
  });
});
