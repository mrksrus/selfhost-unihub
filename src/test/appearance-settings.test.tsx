import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { api } from '@/lib/api';
import { savedSettingsAnswer, userSettingsAnswer } from './settings-fixtures';
import { ACCENTS, accentChannels, accentForeground, contrastRatio } from '@/lib/accent';
import { THEMES } from '@/lib/theme';
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
  vi.mocked(api.get).mockResolvedValue(userSettingsAnswer());
  vi.mocked(api.put).mockImplementation(async (_path: string, body: unknown) => savedSettingsAnswer(body));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); document.documentElement.removeAttribute('style'); document.documentElement.removeAttribute('data-theme'); });

describe('appearance settings', () => {
  it('a chosen accent is saved with the account and applied to the page at once', async () => {
    show();
    const violet = await screen.findByRole('radio', { name: 'Violet' });
    await waitFor(() => expect(violet).toBeEnabled());
    expect(screen.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('');

    fireEvent.click(violet);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values', { values: { accent_color: 'violet' } }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--primary')).toBe('258 90% 62%'));
    expect(document.documentElement.style.getPropertyValue('--ring')).toBe('255 92% 76%');
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toMatch(/^data:image\/svg\+xml/);
    expect(localStorage.getItem('unihub:accent')).toBe('violet');
    expect(violet).toHaveAttribute('aria-checked', 'true');
  });

  it('the saved accent is applied when the preferences load', async () => {
    vi.mocked(api.get).mockResolvedValue(userSettingsAnswer({ accent_color: 'teal' }));
    show();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe('172 66% 50%'));
    // White on the dark theme's bright teal would be illegible; buttons and selected items use black.
    expect(document.documentElement.style.getPropertyValue('--primary-foreground')).toBe('0 0% 0%');
    expect(document.documentElement.style.getPropertyValue('--accent-foreground')).toBe('0 0% 0%');
    expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
  });

  it('two quick choices are saved in order and the later one stays', async () => {
    const answers: Array<() => void> = [];
    vi.mocked(api.put).mockImplementation((_path: string, body: unknown) =>
      new Promise(resolve => { answers.push(() => resolve(savedSettingsAnswer(body))); }));
    show();
    const violet = await screen.findByRole('radio', { name: 'Violet' });
    await waitFor(() => expect(violet).toBeEnabled());

    fireEvent.click(violet);
    await waitFor(() => expect(violet).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(screen.getByRole('radio', { name: 'Teal' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true'));
    // The second choice waits for the first answer, so the server stores them in the order they were made.
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => { answers[0](); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(vi.mocked(api.put).mock.calls.map(call => call[1])).toEqual([{ values: { accent_color: 'violet' } }, { values: { accent_color: 'teal' } }]);

    answers[1]();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--primary')).toBe('172 66% 50%'));
    expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
  });

  it('when both of two quick choices fail, the saved accent comes back, not the first choice', async () => {
    vi.mocked(api.put).mockResolvedValue({ error: 'Server unavailable', status: 503 });
    show();
    const violet = await screen.findByRole('radio', { name: 'Violet' });
    await waitFor(() => expect(violet).toBeEnabled());

    fireEvent.click(violet);
    fireEvent.click(screen.getByRole('radio', { name: 'Teal' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true'));
    expect(violet).toHaveAttribute('aria-checked', 'false');
  });
});

describe('looks', () => {
  it('a chosen look is kept on this device and marks the page; the default clears it', async () => {
    show();
    const oled = await screen.findByRole('radio', { name: /OLED black/ });
    expect(screen.getByRole('radio', { name: /^Default/ })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(oled);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('oled'));
    expect(localStorage.getItem('unihub:theme:dark')).toBe('oled');
    expect(oled).toHaveAttribute('aria-checked', 'true');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000000');

    fireEvent.click(screen.getByRole('radio', { name: /^Default/ }));
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme')).toBe(false));
    expect(localStorage.getItem('unihub:theme:dark')).toBeNull();
  });

  it('switching to light gives the page and the browser bar the light background', async () => {
    document.documentElement.className = 'dark';
    document.head.insertAdjacentHTML('beforeend', '<style>.dark { --background: 0 0% 0%; } .light { --background: 0 0% 100%; }</style>');
    show();
    fireEvent.click(await screen.findByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(document.documentElement).toHaveClass('light'));
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#ffffff');
    expect(document.documentElement.style.backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('System on a light device never paints the page black while the theme resolves', async () => {
    // The start screen is fixed over a body of no height, so the page's own
    // background is what shows behind it until the first page renders.
    localStorage.setItem('theme', 'system');
    const painted: string[] = [];
    const observer = new MutationObserver(records => { for (const record of records) painted.push(record.oldValue ?? ''); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    show();
    await waitFor(() => expect(document.documentElement).toHaveClass('light'));
    await waitFor(() => expect(document.documentElement.style.backgroundColor).not.toBe(''));
    painted.push(...observer.takeRecords().map(record => record.oldValue ?? ''), document.documentElement.getAttribute('style') ?? '');
    observer.disconnect();
    expect(painted.filter(style => /background-color:\s*rgb\(0, 0, 0\)/.test(style))).toEqual([]);
  });

  it('a stored look is applied on load, together with the accent it needs', async () => {
    localStorage.setItem('unihub:theme:dark', 'contrast');
    localStorage.setItem('unihub:accent', 'indigo');
    show();
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('contrast'));
    // High contrast lifts the accent until it stands out from the black page at 7:1.
    const primary = document.documentElement.style.getPropertyValue('--primary');
    expect(primary).not.toBe('239 84% 62%');
    expect(contrastRatio(primary, '0 0% 0%')).toBeGreaterThanOrEqual(7);
  });
});

describe('accent colours', () => {
  it('every accent keeps text on it legible (WCAG AA, 4.5:1) in both themes and every look', () => {
    for (const accent of ACCENTS) {
      for (const theme of THEMES) {
        const dark = theme.mode === 'dark';
        const background = accentChannels(accent.id, dark, theme);
        expect(contrastRatio(background, accentForeground(accent.id, dark, theme)), `${accent.id} ${theme.mode} ${theme.id}`).toBeGreaterThanOrEqual(4.5);
        if (theme.minContrast) expect(contrastRatio(background, dark ? '0 0% 0%' : '0 0% 100%'), `${accent.id} ${theme.mode} ${theme.id}`).toBeGreaterThanOrEqual(theme.minContrast);
      }
    }
  });
});

// The production CSP (docker/nginx/security-headers.conf) allows scripts from
// this origin only, so the pre-paint theme script must be a file (P-02).
describe('pre-paint theme script', () => {
  const themeInit = readFileSync(path.resolve(__dirname, '../../public/theme-init.js'), 'utf8');

  it('index.html loads every script from a file and the theme script before anything else', () => {
    const html = readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every(attributes => /\bsrc=/.test(attributes))).toBe(true);
    expect(scripts[0]).toMatch(/src="\/theme-init\.js"/);
    expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('<body>'));
    expect(html.indexOf('<link ')).toBeGreaterThan(html.indexOf('/theme-init.js'));
  });

  it('colours the page from the stored mode and look without the application', () => {
    document.documentElement.className = 'dark';
    localStorage.setItem('theme', 'light');
    localStorage.setItem('unihub:theme:light', 'paper');
    new Function(themeInit)();
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(THEMES.some(theme => theme.mode === 'light' && theme.id === 'paper')).toBe(true);
    localStorage.clear();
    new Function(themeInit)();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});
