import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import InstallPrompt from '@/components/pwa/InstallPrompt';
import { INSTALL_REMIND_AFTER_MS, installPromptAllowed } from '@/lib/install-prompt';

function offerInstall(outcome: 'accepted' | 'dismissed' = 'dismissed') {
  const event = Object.assign(new Event('beforeinstallprompt'), {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  });
  act(() => { window.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }) as MediaQueryList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('install prompt', () => {
  it('Later hides it until the next day', () => {
    render(<InstallPrompt />);
    offerInstall();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText('Install UniHub')).not.toBeInTheDocument();
    expect(installPromptAllowed()).toBe(false);
    expect(installPromptAllowed(Date.now() + INSTALL_REMIND_AFTER_MS + 1000)).toBe(true);
  });

  it('No stops asking for good', () => {
    render(<InstallPrompt />);
    offerInstall();
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.queryByText('Install UniHub')).not.toBeInTheDocument();
    expect(installPromptAllowed(Date.now() + 365 * INSTALL_REMIND_AFTER_MS)).toBe(false);
  });

  it('an ignored prompt is not shown again on the same day', () => {
    const first = render(<InstallPrompt />);
    offerInstall();
    expect(screen.getByText('Install UniHub')).toBeInTheDocument();
    first.unmount();
    render(<InstallPrompt />);
    offerInstall();
    expect(screen.queryByText('Install UniHub')).not.toBeInTheDocument();
  });

  it('Install opens the browser dialog and a cancelled dialog counts as Later', async () => {
    render(<InstallPrompt />);
    const event = offerInstall('dismissed');
    localStorage.clear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install' })); });
    expect(event.prompt).toHaveBeenCalled();
    expect(installPromptAllowed()).toBe(false);
    expect(installPromptAllowed(Date.now() + INSTALL_REMIND_AFTER_MS + 1000)).toBe(true);
  });

  it('never asks after the app was installed', () => {
    render(<InstallPrompt />);
    act(() => { window.dispatchEvent(new Event('appinstalled')); });
    expect(installPromptAllowed(Date.now() + 365 * INSTALL_REMIND_AFTER_MS)).toBe(false);
  });
});
