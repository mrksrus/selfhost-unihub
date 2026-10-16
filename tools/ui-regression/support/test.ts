// The Playwright `test` used by every check: the real built frontend from the
// loopback server, /api answered by the synthetic router, every other network
// request refused and reported as a failure, a fixed clock, pinned fonts and
// reduced motion.
import { test as base, expect, type Page } from '@playwright/test';
import { createApiRouter, FIXED_NOW, type ApiRouter } from './fixtures.ts';
import { fontFile, fontStylesheet } from './server.mts';
import { markBaselineUsed } from './used-baselines.mts';

export type ThemeMode = 'dark' | 'light' | 'system';

interface Options {
  /** Stored theme mode on this device before the first load (next-themes `theme` key). */
  theme: ThemeMode;
}

interface Fixtures {
  api: ApiRouter;
  /** Opens a path and waits until the page has settled (see `settle`). */
  open: (path: string) => Promise<void>;
  settle: () => Promise<void>;
}

export const test = base.extend<Options & Fixtures>({
  theme: ['dark', { option: true }],
  // Global setup picks a free loopback port after the config has loaded.
  baseURL: async ({}, use) => use(process.env.UNIHUB_UI_ORIGIN),

  api: async ({ context, page, theme }, use) => {
    const origin = process.env.UNIHUB_UI_ORIGIN;
    if (!origin) throw new Error('UNIHUB_UI_ORIGIN is not set; run through playwright.config.ts (global setup starts the server).');
    const router = createApiRouter();
    const refused: string[] = [];
    const pageErrors: string[] = [];

    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) {
        if (!url.pathname.startsWith('/api/') || url.pathname === '/api/events') return route.continue();
        let body: unknown = null;
        try { body = request.postDataJSON(); } catch { body = request.postData(); }
        const reply = router.handle(url, request.method(), body);
        return route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body) });
      }
      if (url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2') {
        return route.fulfill({ status: 200, contentType: 'text/css', body: fontStylesheet() });
      }
      const font = fontFile(url);
      if (font) return route.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'Access-Control-Allow-Origin': '*' }, body: font });
      refused.push(`${request.method()} ${request.url()}`);
      return route.abort('blockedbyclient');
    });
    // Service workers would answer requests outside page.route; the config blocks them.
    page.on('pageerror', error => pageErrors.push(String(error.stack || error)));

    await page.clock.setFixedTime(FIXED_NOW);
    await page.addInitScript(theme => {
      // Seed only the first load of the tab, so a reload keeps what the test changed.
      if (sessionStorage.getItem('ui-regression:seeded')) return;
      sessionStorage.setItem('ui-regression:seeded', '1');
      localStorage.setItem('theme', theme);
    }, theme);

    await use(router);

    expect(refused, 'requests outside the loopback frontend and the synthetic API were refused').toEqual([]);
    expect(router.unhandled, 'API requests without a synthetic fixture').toEqual([]);
    expect(pageErrors, 'uncaught page errors').toEqual([]);
  },

  settle: async ({ page, api }, use) => {
    await use(async () => {
      await page.waitForLoadState('load');
      // Quiet means no new API request for 300 ms in a row (the router answers synchronously).
      let seen = api.requests;
      let quietSince = Date.now();
      const deadline = Date.now() + 15_000;
      while (Date.now() - quietSince < 300) {
        if (Date.now() > deadline) throw new Error('Page did not settle: it kept sending API requests for 15 s.');
        await page.waitForTimeout(50);
        if (api.requests !== seen) { seen = api.requests; quietSince = Date.now(); }
      }
      // A late layout can ask for another weight after `fonts.ready` resolved; wait until none is loading.
      await expect.poll(() => page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].filter(face => face.status === 'loading').length;
      }), { message: 'web fonts still loading' }).toBe(0);
      const inter = await page.evaluate(() => [...document.fonts].some(face => face.family.replace(/"/g, '') === 'Inter' && face.status === 'loaded'));
      expect(inter, 'Inter must come from the pinned font files before any capture').toBe(true);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    });
  },

  open: async ({ page, settle }, use) => {
    await use(async path => {
      await page.goto(path);
      await settle();
    });
  },
});

export { expect };

/** The options for a named viewport of docs/UI_ACCEPTANCE.md "Fixed conditions". */
export const VIEWPORTS = {
  wide: { viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false },
  phone: { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true },
} as const;

export const THEMES = ['dark', 'light'] as const;

/** Compares the viewport with an approved baseline (never writes one outside `npm run update`). */
export async function expectBaseline(page: Page, name: string) {
  markBaselineUsed(name);
  // No hover state in a reference picture: the pointer leaves the page.
  await page.mouse.move(-1, -1);
  await expect(page).toHaveScreenshot(name);
}

export async function pointerIsCoarse(page: Page) {
  return page.evaluate(() => matchMedia('(pointer: coarse)').matches);
}
