import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InstallPrompt from '@/components/pwa/InstallPrompt';
import { api } from '@/lib/api';
import { INSTALLED_AT_KEY } from '@/lib/install-prompt';
import { saveFile } from '@/lib/platform';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

const ANDROID_BROWSER = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const ANDROID_DOWNLOAD = { url: '/downloads/unihub.apk', versionName: '0.21.0', versionCode: 21000, size: 6_300_000, sha256: 'a'.repeat(64) };

function useUserAgent(value: string) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(value);
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><InstallPrompt /></QueryClientProvider>);
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.get).mockResolvedValue({ data: { app: 'unihub', server: '0.21.0', android: ANDROID_DOWNLOAD } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.UniHubAndroid;
});

describe('install offer', () => {
  it('offers the Android app this server carries on an Android phone, with its download and a link back into the app', async () => {
    useUserAgent(ANDROID_BROWSER);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Android app' }));
    const download = screen.getByRole('link', { name: /Download · 6\.0 MB/ });
    expect(download).toHaveAttribute('href', '/downloads/unihub.apk');
    const open = screen.getByRole('link', { name: 'Open in app' });
    expect(open.getAttribute('href')).toContain(`server=${encodeURIComponent(window.location.origin)}`);
    expect(open.getAttribute('href')).toContain('scheme=unihub;package=io.github.mrksrus.unihub');
    // Downloading counts as installing: the card does not come back every day.
    download.addEventListener('click', event => event.preventDefault());
    fireEvent.click(download);
    expect(window.localStorage.getItem(INSTALLED_AT_KEY)).not.toBeNull();
  });

  it('offers only the web app on a computer, when the browser can install it', async () => {
    useUserAgent(DESKTOP);
    mount();
    expect(screen.queryByText('Install UniHub')).not.toBeInTheDocument();
    const offer = Object.assign(new Event('beforeinstallprompt'), {
      prompt: vi.fn(async () => {}), userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    });
    act(() => { window.dispatchEvent(offer); });
    expect(await screen.findByRole('button', { name: 'Install' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Android app' })).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('is never shown inside the Android app', async () => {
    useUserAgent(`${ANDROID_BROWSER} UniHubAndroid/0.21.0 (21000)`);
    mount();
    await act(async () => {});
    expect(screen.queryByText('Install UniHub')).not.toBeInTheDocument();
  });
});

describe('saving files in the Android app', () => {
  it('hands the file to the app, because a WebView cannot download blob links', async () => {
    useUserAgent(`${ANDROID_BROWSER} UniHubAndroid/0.21.0 (21000)`);
    const postMessage = vi.fn();
    window.UniHubAndroid = { postMessage };
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    saveFile(new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ type: 'saveFile', name: 'note.txt', mime: 'text/plain', data: btoa('hello') });
    expect(click).not.toHaveBeenCalled();
  });
});
