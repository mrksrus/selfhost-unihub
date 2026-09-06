import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UpdatePrompt from '@/components/pwa/UpdatePrompt';

afterEach(() => { delete window.__unihubUpdateAvailable; });

describe('PWA update consent', () => {
  it('keeps a dirty editor intact until the user requests the update', () => {
    const apply = vi.fn();
    window.addEventListener('unihub-apply-update', apply);
    const view = render(<><textarea aria-label="Draft" defaultValue="Unsaved message" /><UpdatePrompt /></>);
    act(() => { window.dispatchEvent(new Event('unihub-update-available')); });
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('Unsaved message');
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(apply).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event('unihub-update-available')); });
    fireEvent.click(screen.getByRole('button', { name: 'Saved — refresh now' }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
    view.unmount();
    window.removeEventListener('unihub-apply-update', apply);
  });

  it('shows an update registered before mount and permits retry after failure', () => {
    window.__unihubUpdateAvailable = true;
    render(<UpdatePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Saved — refresh now' }));
    act(() => { window.dispatchEvent(new Event('unihub-update-failed')); });
    expect(screen.getByRole('alert')).toHaveTextContent('could not be applied');
    expect(screen.getByRole('button', { name: 'Saved — refresh now' })).toBeEnabled();
  });
});
