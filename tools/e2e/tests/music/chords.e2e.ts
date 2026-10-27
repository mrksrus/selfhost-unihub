import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { ok, pageApi } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

// 23-08 (B-26): a long chord sheet (300 lines, about 18,500 characters) saved in Music is
// still whole after a reload, or is refused with a clear limit; it is never cut silently.
// On 0.24.2 it shows "Chords saved" and keeps the first 10,000 characters.
test('[23-08 B-26] a long chord sheet is kept whole or refused, never cut silently', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const title = `Synthetic song ${runId()}`;
  await app.open('/recordings');
  await browser.locator('input[type="file"]').setInputFiles(['fixtures/synthetic-tone.wav']);
  await screen.getByLabel('Name', { exact: true }).fill(title);
  await screen.getByLabel('Category', { exact: true }).tap();
  await screen.getByRole('option', 'Music', { exact: true }).tap();
  await screen.getByLabel('Chords', { exact: true }).fill('C G Am F');
  await screen.getByRole('button', 'Save recording', { exact: true }).tap();
  await expect.poll(async () => {
    const { recordings } = ok(await pageApi<{ recordings: { title: string }[] }>(browser, 'GET', '/api/recordings?category=music'), 'list music');
    return recordings.some((recording) => recording.title === title);
  }, { timeout: 60_000 }).toBe(true);

  await app.open('/music');
  await screen.getByRole('button', `Edit chords for ${title}`).tap();
  const chords = Array.from({ length: 300 }, (_, i) => `Verse ${i} | Cmaj7  G/B  Am7  Fadd9 | synthetic lyric line`).join('\n');
  await screen.getByRole('textbox', `Chords for ${title}`).fill(chords);
  await screen.getByRole('button', 'Save chords', { exact: true }).tap();
  const saved = screen.getByText('Chords saved', { exact: true });
  const refused = screen.getByText(/too long|characters|limit/i);
  await expect(saved.or(refused).first()).toBeVisible();
  if (await saved.isVisible()) {
    await browser.reload();
    await screen.getByRole('button', `Edit chords for ${title}`).tap();
    const editor = screen.getByRole('textbox', `Chords for ${title}`);
    await expect(editor).toBeVisible();
    const kept = await editor.inputValue();
    expect(kept.length, 'characters kept after a reload').toBe(chords.length);
    expect(kept === chords, 'the same text after a reload').toBe(true);
  }
});
