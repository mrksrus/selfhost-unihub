import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader, PageShell, PanelHeader, PanelItem } from '@/components/layout/PageShell';

// matchMedia never matches in tests, so this is the wide layout: the panel is a column.
function mount() {
  return render(
    <MemoryRouter>
      <PageShell panel={<><PanelHeader title="Contacts" /><PanelItem>Favorites</PanelItem></>} panelLabel="Contact lists" panelId="test">
        <PageHeader title="Contacts" scope="All contacts" />
      </PageShell>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('PageShell panel', () => {
  it('folds the panel away, remembers it after a remount and opens it from the scope', () => {
    mount();
    expect(screen.getByRole('complementary', { name: 'Contact lists' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }));
    expect(screen.queryByRole('complementary', { name: 'Contact lists' })).not.toBeInTheDocument();

    cleanup();
    mount();
    expect(screen.queryByRole('complementary', { name: 'Contact lists' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All contacts' }));
    const sheet = screen.getByRole('dialog', { name: 'Contact lists' });
    expect(within(sheet).getByRole('button', { name: 'Favorites' })).toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Keep panel open' }));
    expect(screen.getByRole('complementary', { name: 'Contact lists' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem('unihub:panel:test')).toBe('false');
  });
});
