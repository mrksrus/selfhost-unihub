import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { onlyOn } from '../support/ui.ts';

interface Frame { reason: string; html: string; body: string | null; bodyHeight: number | null; viewport: number }

// Records the page's background from its first paint, before the app's own scripts run.
function recordFrames() {
  const w = window as unknown as { __frames: Frame[] };
  w.__frames = [];
  const sample = (reason: string) => {
    const html = document.documentElement, body = document.body;
    if (!html) return;
    w.__frames.push({ reason, html: getComputedStyle(html).backgroundColor, body: body ? getComputedStyle(body).backgroundColor : null,
      bodyHeight: body ? body.getBoundingClientRect().height : null, viewport: innerHeight });
  };
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) sample(entry.name); }).observe({ type: 'paint', buffered: true });
  let count = 0;
  const tick = () => { sample('frame'); if (++count < 60) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

const dark = (color: string | null) => {
  const [r, g, b, a = 1] = (color?.match(/[\d.]+/g) ?? []).map(Number);
  return color != null && a > 0 && (0.2126 * r + 0.7152 * g + 0.0722 * b) < 60;
};

// 23-02 / 23-04: with Light, or System on a light device, a reload never paints a dark
// screen first (the body, or the page behind a body shorter than the screen), and the
// interface font is Inter, loaded as a web font. Browser chrome (status bar colour) needs
// a device.
test('[23-02 23-04] Light and System themes paint light from the first frame, in Inter', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  await browser.emulateMedia({ colorScheme: 'light' });
  await browser.addInitScript(recordFrames);
  await app.open('/settings?section=appearance');
  for (const mode of ['Light', 'System']) {
    await screen.getByRole('radiogroup', 'Theme').getByRole('radio', mode, { exact: true }).tap();
    await browser.reload();
    await expect(screen.getByRole('radiogroup', 'Theme').getByRole('radio', mode, { exact: true })).toBeChecked();
    const result = await browser.evaluate(async () => {
      await document.fonts.ready;
      return {
        frames: (window as unknown as { __frames: Frame[] }).__frames,
        font: getComputedStyle(document.body).fontFamily,
        inter: [...document.fonts].some((face) => face.family.replace(/["']/g, '') === 'Inter' && face.status === 'loaded'),
      };
    });
    expect(result.frames.length, 'frames were recorded').toBeGreaterThan(0);
    const darkFrames = result.frames.filter((f) => dark(f.body) || (dark(f.html) && (f.bodyHeight ?? 0) < f.viewport));
    expect(darkFrames, `${mode}: no dark frame on reload`).toEqual([]);
    expect(result.font.split(',')[0].replace(/["']/g, '').trim(), 'interface font').toBe('Inter');
    expect(result.inter, 'Inter loaded as a web font').toBe(true);
  }
  // Back to the default for this browser (the theme is kept per device).
  await screen.getByRole('radiogroup', 'Theme').getByRole('radio', 'Dark', { exact: true }).tap();
});
