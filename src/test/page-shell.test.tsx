import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('folds the panel away, remembers it after a remount and opens it from the scope, keeping keyboard focus', async () => {
    mount();
    expect(screen.getByRole('complementary', { name: 'Contact lists' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }));
    expect(screen.queryByRole('complementary', { name: 'Contact lists' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All contacts' })).toHaveFocus();

    cleanup();
    mount();
    expect(screen.queryByRole('complementary', { name: 'Contact lists' })).not.toBeInTheDocument();
    const scope = screen.getByRole('button', { name: 'All contacts' });
    scope.focus();
    fireEvent.click(scope);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Contact lists' })).getByRole('button', { name: 'Favorites' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(scope).toHaveFocus());

    fireEvent.click(scope);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Contact lists' })).getByRole('button', { name: 'Keep panel open' }));
    expect(screen.getByRole('complementary', { name: 'Contact lists' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem('unihub:panel:test')).toBe('false');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hide panel' })).toHaveFocus());
  });
});
