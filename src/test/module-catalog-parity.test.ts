import { describe, expect, it } from 'vitest';
import { MODULE_CATALOG, PAGE_CATALOG as SERVER_PAGES } from '../../api/src/services/module-catalog';
import { PAGE_CATALOG, legacyOfflineModules, moduleForPath, type PageId } from '@/lib/modules';
import { pageLink } from '@/lib/navigation';

// The browser keeps its own copy of the module and page lists (for offline
// snapshots and before the server answers). They must match the server's.
describe('module catalog parity', () => {
  it('lists the same pages, in the same order, with the same modules', () => {
    expect(PAGE_CATALOG).toEqual(SERVER_PAGES.map(({ id, label, module }) => ({ id, label, module })));
  });

  it('knows the same modules with the same labels and background support', () => {
    expect(legacyOfflineModules.map(({ id, label, backgroundSupported }) => ({ id, label, backgroundSupported })))
      .toEqual(MODULE_CATALOG.map(({ id, label, backgroundSupported }) => ({ id, label, backgroundSupported })));
  });

  it('has a link for every page, and every module page route maps back to its module', () => {
    for (const page of SERVER_PAGES) {
      const link = pageLink(page.id as PageId);
      expect(link, page.id).toBeDefined();
      expect(moduleForPath(link.href) ?? null, page.id).toBe(page.module);
    }
  });
});
