import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { DEFAULT_PREFERENCES } from '@/lib/settings-api';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { PreferenceAccent } from '@/components/theme/PreferenceAccent';
import AppearanceSettings from '@/components/settings/AppearanceSettings';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<ThemeProvider><QueryClientProvider client={client}><PreferenceAccent /><AppearanceSettings /></QueryClientProvider></ThemeProvider>);
}

beforeEach(() => {
  localStorage.clear();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg"><meta name="theme-color" content="#000000">';
  vi.mocked(api.get).mockResolvedValue({ data: { preferences: { ...DEFAULT_PREFERENCES } } });
  vi.mocked(api.put).mockImplementation(async (_path: string, body: unknown) => ({ data: { preferences: body } }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); document.documentElement.removeAttribute('style'); });

describe('appearance settings', () => {
  it('a chosen accent is saved with the account and applied to the page at once', async () => {
    show();
    const violet = await screen.findByRole('radio', { name: 'Violet' });
    await waitFor(() => expect(violet).toBeEnabled());
    expect(screen.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('');

    fireEvent.click(violet);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/preferences', expect.objectContaining({ accent_color: 'violet' })));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--primary')).toBe('258 90% 66%'));
    expect(document.documentElement.style.getPropertyValue('--ring')).toBe('255 92% 76%');
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toMatch(/^data:image\/svg\+xml/);
    expect(localStorage.getItem('unihub:accent')).toBe('violet');
    expect(violet).toHaveAttribute('aria-checked', 'true');
  });

  it('the saved accent is applied when the preferences load', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { preferences: { ...DEFAULT_PREFERENCES, accent_color: 'teal' } } });
    show();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe('172 66% 50%'));
    expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
  });
});
