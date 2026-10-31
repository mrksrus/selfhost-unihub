import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ok, pageApi } from '../support/api.ts';
import { centreOf, longPressDrag, mouseDrag, onlyOn } from '../support/ui.ts';

// 27-08: pages in Settings → Pages and modules are reordered by their handle; the
// rail (desktop) and the bottom bar (phone) follow, and the order survives a reload.
test('[27-08] dragging a page by its handle reorders the navigation', { session: 'alex', timeout: 180_000 }, async ({ app, screen, browser }) => {
  const target = await onlyOn(browser, 'desktop', 'phone');
  const defaultOrder = ['mail', 'calendar', 'todo', 'contacts', 'recordings', 'music', 'today'];
  await app.open('/settings?section=pages');
  ok(await pageApi(browser, 'PUT', '/api/modules', { page_order: defaultOrder }), 'reset page order');
  try {
    await app.open('/settings?section=pages');
    const pages = screen.getByRole('list', 'Pages');
    await expect(pages.getByRole('listitem').first()).toContainText('Mail');
    const from = await centreOf(pages.getByRole('button', 'Reorder Contacts'));
    const to = await centreOf(pages.getByRole('listitem').filter({ hasText: 'Mail' }));
    if (target === 'desktop') await mouseDrag(browser, from, { x: from.x, y: to.y - 6 });
    else await longPressDrag(browser, from, { x: from.x, y: to.y - 6 });
    await expect(pages.getByRole('listitem').first()).toContainText('Contacts');
    await expect.poll(async () => ok(await pageApi<{ pages: { id: string }[] }>(browser, 'GET', '/api/modules'), 'read pages').pages.map(page => page.id), { timeout: 15_000 })
      .toEqual(['contacts', 'mail', 'calendar', 'todo', 'recordings', 'music', 'today']);

    await browser.reload();
    await expect(pages.getByRole('listitem').first()).toContainText('Contacts');
    // The rail (desktop) or the bottom bar (phone): the first page is now Contacts.
    const navigation = screen.getByRole('navigation', 'Main', { visible: true });
    await expect(navigation.getByRole('link').first()).toHaveAccessibleName(/Contacts/);
  } finally {
    ok(await pageApi(browser, 'PUT', '/api/modules', { page_order: defaultOrder }), 'restore page order');
  }
});
