import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionList } from '@/components/layout/AttentionList';
import { appUpdateItem } from '@/hooks/use-attention';
import { resetAppUpdateState, useAppUpdate } from '@/hooks/use-app-update';
import { emitAppEvent } from '@/lib/app-events';

function UpdateEntry() {
  const item = appUpdateItem(useAppUpdate());
  return <AttentionList items={item ? [item] : []} />;
}
const renderEntry = (extra?: React.ReactNode) => render(<MemoryRouter>{extra}<UpdateEntry /></MemoryRouter>);

beforeEach(() => { resetAppUpdateState(); });
afterEach(() => { cleanup(); delete window.__unihubUpdateAvailable; resetAppUpdateState(); });

describe('PWA update consent', () => {
  it('keeps a dirty editor intact until the user requests the update', () => {
    const apply = vi.fn();
    window.addEventListener('unihub:apply-update', apply);
    const view = renderEntry(<textarea aria-label="Draft" defaultValue="Unsaved message" />);
    act(() => { emitAppEvent('unihub:update-available'); });
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('Unsaved message');
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(apply).not.toHaveBeenCalled();
    expect(screen.queryByText('UniHub update ready')).not.toBeInTheDocument();
    act(() => { emitAppEvent('unihub:update-available'); });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
    view.unmount();
    window.removeEventListener('unihub:apply-update', apply);
  });

  it('shows an update registered before mount and permits retry after failure', () => {
    window.__unihubUpdateAvailable = true;
    resetAppUpdateState();
    renderEntry();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    act(() => { emitAppEvent('unihub:update-failed'); });
    expect(screen.getByRole('alert')).toHaveTextContent('could not be applied');
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeEnabled();
  });
});
