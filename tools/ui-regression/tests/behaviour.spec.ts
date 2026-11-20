// Pinned interface behaviour from PROJECT-PREFERENCES.md, checked in the real
// built frontend: content rows stay in view (P-07), context panels fold
// independently and remember it (P-08), keyboard focus is visible and returns
// (P-12), the theme is painted before the app runs and follows the choice
// (P-02), and touch targets are big enough and never overlap (P-11).
import type { Page } from '@playwright/test';
import { POLICIES_EFFECTIVE_TWO_FACTOR, RICH_TASK, TASKS } from '../support/fixtures.ts';
import { touchViolations } from '../support/geometry.ts';
import { expectOnlyKnown, KNOWN_DEFECTS } from '../support/known-defects.ts';
import { customRepeat, expect, pointerIsCoarse, sharedCalendars, test, THEMES, VIEWPORTS, withChat } from '../support/test.ts';

// Synthetic files for the composer's attachments.
const SYNTHETIC_PDF = { name: 'quarterly-report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic') };
const SYNTHETIC_JPG = { name: 'site-photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('synthetic jpeg') };

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
        expectOnlyKnown(await clippedRows(page, 'section > ul > li', 'ToDo'), []);
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

    // The page allows pinch zoom, so anything wider than the screen (even a
    // hidden label) makes the phone's browser widen the layout, and the bottom
    // bar leaves the screen.
    for (const path of ['/todo', '/mail', '/recordings', '/settings?section=appearance']) {
      test(`${path} keeps the layout at the screen width (phone)`, async ({ page, open }) => {
        await open(path);
        const { layout, content } = await page.evaluate(() => ({ layout: window.innerWidth, content: document.documentElement.scrollWidth }));
        expect({ layout, content }).toEqual({ layout: VIEWPORTS.phone.viewport.width, content: VIEWPORTS.phone.viewport.width });
      });
    }
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
    // With files attached: their chips share the message's toolbar row.
    await page.locator('#compose-attachments-dialog').setInputFiles([SYNTHETIC_PDF, SYNTHETIC_JPG]);
    await expect(page.getByRole('list', { name: 'Attachments' }).getByRole('button')).toHaveCount(2);
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
  });

  test('Recordings', async ({ page, open }) => {
    await open('/recordings');
    expectOnlyKnown(await touchViolations(page), [KNOWN_DEFECTS.recordingTagTargets]);
  });

  test('Contacts list and detail', async ({ page, open }) => {
    await open('/contacts');
    expectOnlyKnown(await touchViolations(page), []);
    await open('/contacts?contact=c-1');
    expectOnlyKnown(await touchViolations(page), []);
  });

  test('Chat: the list and a chat with every kind of message', async ({ page, open, settle }) => {
    await withChat(page);
    await open('/chat');
    await expect(page.getByRole('list', { name: 'Chats' })).toBeVisible();
    expectOnlyKnown(await touchViolations(page), []);
    // An open chat lies over the page and its bottom bar: only the chat is measured.
    await open('/chat?c=chat-blair');
    await expect(page.getByText('And the holiday list?')).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, 'section[aria-label="Chat with Blair Example"]'), []);
  });

  test('A shared book, its bin, its share dialog and a company entry', async ({ page, open, settle }) => {
    await open('/contacts?book=book-suppliers');
    await expect(page.getByRole('button', { name: /^Maria Okafor/ })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page), []);
    await page.getByRole('radio', { name: /^Deleted/ }).click();
    await expect(page.getByRole('list', { name: 'Deleted items' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page), []);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(page.getByRole('list', { name: 'People and groups to add' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
    await open('/contacts?book=company');
    await expect(page.getByRole('button', { name: /^Katherine/ })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page), []);
    await page.getByRole('button', { name: /^Katherine/ }).click();
    await expect(page.getByRole('region', { name: 'Groups' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page), []);
  });

  test('Shared calendars: the panel, a calendar\'s settings, its share dialog and an event a contributor reads', async ({ page, open, settle }) => {
    await sharedCalendars(page);
    await open('/calendar');
    await page.getByRole('button', { name: /calendars$/ }).first().click();
    await expect(page.getByRole('region', { name: 'Shared with me' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), [KNOWN_DEFECTS.calendarCheckboxes]);
    await page.getByRole('button', { name: 'Settings for Personal' }).click();
    await expect(page.getByRole('dialog', { name: 'Personal' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
    await page.getByRole('dialog', { name: 'Personal' }).getByRole('button', { name: 'Share', exact: true }).click();
    await expect(page.getByRole('list', { name: 'People and groups to add' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
    await open('/calendar');
    await page.getByRole('button', { name: /Weekly support meeting/ }).click();
    await expect(page.getByRole('dialog', { name: 'Event' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
  });

  test('Calendar: an offered calendar in the panel, the hand-over dialog and a custom repeat', async ({ page, open, settle }) => {
    await sharedCalendars(page, { offered: true });
    await open('/calendar');
    await page.getByRole('button', { name: /calendars$/ }).first().click();
    await expect(page.getByRole('region', { name: 'Offer of Support rota' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), [KNOWN_DEFECTS.calendarCheckboxes]);
    await page.getByRole('button', { name: 'Settings for Personal' }).click();
    await page.getByRole('dialog', { name: 'Personal' }).getByRole('button', { name: 'Hand over…' }).click();
    await expect(page.getByRole('radio', { name: /Blair Example/ })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]:has(#hand-over-search)'), []);
    await open('/calendar');
    await customRepeat(page);
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
  });

  test('Contact editor', async ({ page, open, settle }) => {
    await open('/contacts?contact=c-1');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Edit contact' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
  });

  test('Merge review', async ({ page, open, settle }) => {
    await open('/contacts?view=duplicates');
    expectOnlyKnown(await touchViolations(page), []);
    await page.getByRole('region', { name: /Group of 2, high confidence/ }).first().getByRole('button', { name: 'Review and merge' }).click();
    await expect(page.getByRole('dialog', { name: 'Merge 2 contacts into one' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
  });

  test('Settings, Mail', async ({ page, open }) => {
    await open('/settings?section=mail');
    await expect(page.getByRole('heading', { name: 'Signatures' })).toBeVisible();
    expectOnlyKnown(await touchViolations(page), []);
  });

  // 0.28: the backup rows' Download and menu, the bin rows' Restore and menu.
  test('Settings, Backup and restore', async ({ page, open, settle }) => {
    await open('/settings?section=backup');
    await expect(page.getByRole('button', { name: 'Create backup' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page), []);
  });

  test('Settings, Bin', async ({ page, open, settle }) => {
    await open('/settings?section=bin');
    await expect(page.getByRole('list', { name: 'Deleted items' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page), []);
  });

  // A long template must not push the dialog's buttons off the screen.
  test('Settings, App lock', async ({ page, open, settle }) => {
    await open('/settings?section=app-lock');
    await expect(page.getByRole('radio', { name: 'Off' })).toBeVisible();
    // The row is the tap target; its input is drawn by the row (RadioRow).
    await page.getByText('Chosen modules', { exact: true }).tap();
    await expect(page.getByRole('list', { name: 'Locked modules' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page), []);
  });

  test('Settings, Security with Devices', async ({ page, open, settle }) => {
    await open('/settings?section=security');
    await expect(page.getByText('UniHub app 0.29.0 on Android')).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page), []);
  });

  // 0.30: the organisation's pages in a phone's hand.
  test.describe('as an administrator', () => {
    test.use({ admin: true });

    test('Server, People', async ({ page, open, settle }) => {
      await open('/admin/users');
      await expect(page.getByRole('link', { name: 'Alex Example' })).toBeVisible();
      await settle();
      expectOnlyKnown(await touchViolations(page), []);
    });

    test('Server, a person', async ({ page, open, settle }) => {
      await open('/admin/users/user-alex');
      await expect(page.getByRole('switch', { name: 'Support: manager' })).toBeVisible();
      await settle();
      expectOnlyKnown(await touchViolations(page), []);
    });

    test('Server, Shared books', async ({ page, open, settle }) => {
      await open('/admin/address-books');
      await expect(page.getByRole('button', { name: 'Restore Trade fair 2025' })).toBeVisible();
      await settle();
      expectOnlyKnown(await touchViolations(page), []);
    });

    test('Server, Calendars and a calendar\'s menu', async ({ page, open, settle }) => {
      await open('/admin/calendars');
      await expect(page.getByRole('button', { name: 'Restore Summer party 2025' })).toBeVisible();
      await settle();
      expectOnlyKnown(await touchViolations(page), []);
      await page.getByRole('button', { name: 'Actions for Team meetings' }).click();
      await expect(page.getByRole('menuitem', { name: 'Hand over…' })).toBeVisible();
      await settle();
      expectOnlyKnown(await touchViolations(page, '[role="menu"]'), []);
    });

    test('Server, a group and its Add people dialog', async ({ page, open, settle }) => {
      await open('/admin/groups/grp-support');
      await expect(page.getByRole('switch', { name: 'Blair Example: manager' })).toBeVisible();
      await settle();
      expectOnlyKnown(await touchViolations(page), []);
      await page.getByRole('button', { name: 'Add people' }).click();
      await expect(page.getByRole('list', { name: 'People to add' })).toBeVisible();
      await settle();
      expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
    });
  });

  test('the two-factor reminder', async ({ page, open, settle }) => {
    await page.route('**/api/policies/effective', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...POLICIES_EFFECTIVE_TWO_FACTOR, two_factor: { required: true, grace_ends_at: '2026-06-20T09:00:00.000Z' } }) }));
    await open('/todo');
    await expect(page.getByRole('button', { name: 'Set up now' })).toBeVisible();
    await settle();
    expectOnlyKnown(await touchViolations(page), []);
  });

  test('a long template keeps Save on screen', async ({ page, open, settle }) => {
    await open('/settings?section=mail');
    await page.getByRole('button', { name: 'New template' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Long');
    await dialog.getByRole('textbox', { name: 'Text' }).click();
    await page.keyboard.type('Line\n'.repeat(50));
    await settle();
    const save = dialog.getByRole('button', { name: 'Save' });
    await save.scrollIntoViewIfNeeded();
    const box = (await save.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
  });
});

// A chat on a phone takes the visible area, so with the keyboard open (a page
// about 560 px tall) the line being written and the newest message stay on
// screen, under the chat's own header.
test.describe('a chat keeps its composer and newest message above the keyboard', () => {
  test.use({ ...VIEWPORTS.phone, viewport: { width: 412, height: 560 } });

  test('typing in a chat at 412×560', async ({ page, open, settle }) => {
    await withChat(page);
    await open('/chat?c=chat-blair');
    const field = page.getByRole('textbox', { name: 'Message to Blair Example' });
    await field.click();
    await page.keyboard.type('One line\nand a second');
    await settle();
    const height = page.viewportSize()!.height;
    for (const control of [field, page.getByRole('button', { name: 'Send' }), page.getByRole('link', { name: 'Back to chats' })]) {
      const box = (await control.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    }
    await expect(page.getByText('And the holiday list?')).toBeInViewport({ ratio: 1 });
    expect((await page.getByText('And the holiday list?').boundingBox())!.y).toBeLessThan((await field.boundingBox())!.y);
  });
});

// With the keyboard open the Android app's page is only about 560 to 600 px
// tall. The phone composer fills the screen from the very top, and typing the
// first line of the message must leave the message most of that screen: the
// field rows scroll away, the message keeps the room between the title bar and
// the toolbar pinned above the button bar (0.24.1, the maintainer's Android
// report; toolbar placement from 0.25.0).
test.describe('the phone composer leaves the message room with the keyboard open', () => {
  for (const [width, height] of [[412, 560], [450, 600]] as const) {
    test.describe(`${width}×${height}`, () => {
      test.use({ ...VIEWPORTS.phone, viewport: { width, height } });

      test(`typing one line shows at least 240 px of the message (${width}×${height})`, async ({ page, open, settle }) => {
        await open('/mail');
        await page.getByRole('button', { name: 'Compose', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await settle();
        // A file attached first: its chip stays in the toolbar row, not below the message.
        await page.locator('#compose-attachments-dialog').setInputFiles(SYNTHETIC_PDF);
        const editor = page.locator('#compose-body');
        await editor.click();
        await page.keyboard.type('Hello');
        await settle();
        const chip = page.getByRole('list', { name: 'Attachments' }).getByRole('button');
        await expect(chip).toHaveText('.pdf');
        // Autosave stores the file with the draft, and the chip says so.
        await expect(chip).toHaveAccessibleName(/^quarterly-report\.pdf, .*, Saved with the draft$/);
        // On screen: in the toolbar row pinned between the message and the button bar (0.25.0).
        const room = await dialog.evaluate(element => {
          const form = element.querySelector('form')!;
          return { top: form.firstElementChild!.getBoundingClientRect().bottom - 1, bottom: form.lastElementChild!.getBoundingClientRect().top + 1 };
        });
        for (const control of [chip, dialog.getByRole('button', { name: 'Attach files' })]) {
          const box = (await control.boundingBox())!;
          expect(box.y).toBeGreaterThanOrEqual(room.top);
          expect(box.y + box.height).toBeLessThanOrEqual(room.bottom);
        }
        // The part of the editor that is on screen: clipped by every scrolling or
        // clipping box around it, and above the dialog's button bar.
        const visible = await editor.evaluate(element => {
          let { top, bottom } = element.getBoundingClientRect();
          for (let box = element.parentElement; box; box = box.parentElement) {
            const { overflowY } = getComputedStyle(box);
            if (overflowY === 'visible') continue;
            const rect = box.getBoundingClientRect();
            top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
          }
          // The toolbar and the buttons are pinned below the scroller.
          const form = element.closest('form')!;
          const pinned = form.children[1]!.getBoundingClientRect();
          return Math.min(bottom, pinned.top, window.innerHeight) - top;
        });
        expect(visible).toBeGreaterThanOrEqual(240);
        // The typed line is on screen too, not hidden under the title bar.
        const caretLine = await editor.evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const rect = range.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        });
        expect(caretLine.top).toBeGreaterThanOrEqual(0);
        expect(caretLine.bottom).toBeLessThanOrEqual(height);
        // Full screen: the composer starts at the very top and spans the width.
        const frame = (await dialog.boundingBox())!;
        expect({ x: frame.x, y: frame.y, width: frame.width }).toEqual({ x: 0, y: 0, width });
      });
    });
  }
});

// The notice of the data rules with every rule in force, on a small
// phone (360×640). The dialog stays inside the viewport, its rules scroll and
// the title and OK can be read and tapped; no control of it is cut off.
const EVERY_RULE = [
  'Your administrator does not allow Download mode for new mail accounts.',
  'Your administrator does not allow Sync mode for new mail accounts.',
  'New mail accounts use Download mode and delete mail at the provider.',
  'Your administrator requires mail to be deleted at the provider once it is downloaded.',
  'Your backups always include downloaded mail.',
  'Your administrator does not allow creating backups.',
  'Your administrator does not allow restoring backups.',
  'Your administrator does not allow deleting backups.',
  'Your backups are kept at least 365 days: until then nobody can delete them.',
  'Your administrator does not allow adding mail or calendar accounts.',
  'Your administrator does not allow removing mail or calendar accounts.',
  'Your administrator does not allow resetting an account\'s data.',
  'Your administrator does not allow deleting your account.',
  'Your administrator does not allow deleting all data of a page.',
  'Your administrator does not allow deleting items from the bin for good.',
];
const SMALL_PHONE = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true } as const;

test.describe('the full rules notice fits a small phone', () => {
  test.use(SMALL_PHONE);
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme });

      test(`every rule, 360×640 (${theme})`, async ({ page, open, settle, api }) => {
        // The person's rules: the synthetic answer with every rule in force and not yet confirmed (a page route answers before the context's router).
        const base = api.handle(new URL(`${process.env.UNIHUB_UI_ORIGIN}/api/policies/effective`), 'GET', null).body as Record<string, unknown>;
        await page.route('**/api/policies/effective', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...base, revision: 3, acknowledged_revision: 2, rules: EVERY_RULE }) }));
        await page.route('**/api/policies/acknowledge', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ acknowledged_revision: 3 }) }));
        await open('/todo');
        const dialog = page.getByRole('dialog', { name: 'Your administrator changed the data rules' });
        await expect(dialog).toBeVisible();
        await settle();
        const { width, height } = SMALL_PHONE.viewport;
        const inside = (box: { x: number; y: number; width: number; height: number } | null, what: string) => {
          expect(box, `${what} has a box`).not.toBeNull();
          expect(box!.y, `${what} starts below the top edge`).toBeGreaterThanOrEqual(0);
          expect(box!.x, `${what} starts right of the left edge`).toBeGreaterThanOrEqual(0);
          expect(box!.y + box!.height, `${what} ends above the bottom edge`).toBeLessThanOrEqual(height + 0.5);
          expect(box!.x + box!.width, `${what} ends left of the right edge`).toBeLessThanOrEqual(width + 0.5);
        };
        inside(await dialog.boundingBox(), 'the dialog');
        inside(await dialog.getByRole('heading', { name: 'Your administrator changed the data rules' }).boundingBox(), 'the title');
        const ok = dialog.getByRole('button', { name: 'OK' });
        inside(await ok.boundingBox(), 'OK');
        await expect(ok).toBeFocused();
        // The rules scroll inside the dialog: the last one comes into view without moving title or OK.
        const body = dialog.getByTestId('notice-body');
        expect(await body.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(40);
        const items = dialog.getByRole('list', { name: 'Rules in force' }).getByRole('listitem');
        await expect(items).toHaveCount(EVERY_RULE.length);
        const okBefore = await ok.boundingBox();
        // Without a pointer: Tab reaches the rules (OK, Close, then the rules, as the focus loop wraps), the keys scroll them
        // until the last one is readable, and Tab goes on to the footer; Shift+Tab comes back.
        await page.keyboard.press('Tab');
        await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(body).toBeFocused();
        await page.keyboard.press('PageDown');
        await expect.poll(() => body.evaluate(element => element.scrollTop), { message: 'PageDown scrolls the rules' }).toBeGreaterThan(100);
        for (let step = 0; step < 12 && (await body.evaluate(element => element.scrollTop + element.clientHeight < element.scrollHeight - 1)); step++) await page.keyboard.press('ArrowDown');
        inside(await items.last().boundingBox(), 'the last rule, after the keys');
        expect(await ok.boundingBox()).toEqual(okBefore);
        await page.keyboard.press('Tab');
        await expect(dialog.getByRole('link', { name: 'Open Settings › Profile' })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(ok).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(body).toBeFocused();
        // A visible focus ring from the tokens on the region.
        expect(await body.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
        expectOnlyKnown(await touchViolations(page, '[role="dialog"]'), []);
        await ok.tap();
        await expect(dialog).toBeHidden();
      });
    });
  }
});
