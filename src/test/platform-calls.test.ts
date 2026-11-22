import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callSupport } from '@/lib/platform';
import { useHandCallsToApp } from '@/hooks/use-chat-calls';
import { chatApi } from '@/lib/chat-api';
import type { ChatCall } from '../../api/src/contracts/chat';

// Who takes calls: a browser and the app's call screen run them in the page;
// the main page of an app that takes calls leaves them to the app and hands it
// a call it hears of first.
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-ada' } }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isEnabled: () => true }) }));
vi.mock('@/hooks/use-app-lock', () => ({ useAppLock: () => ({ locked: () => false }) }));
vi.mock('@/hooks/use-settings', () => ({ useUserSettings: () => ({ values: { chat_notification_detail: 'full' } }) }));

const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const APP = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 UniHubAndroid/0.35.0 (35000) UniHubBridge/5';

function userAgent(value: string) {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => value });
}
function bridge() {
  const sent: Record<string, unknown>[] = [];
  window.UniHubAndroid = { postMessage: raw => { sent.push(JSON.parse(raw)); }, addEventListener: () => undefined, removeEventListener: () => undefined };
  return sent;
}

afterEach(() => {
  delete window.UniHubAndroid;
  userAgent(BROWSER);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('calls at the device boundary', () => {
  it('runs calls in a browser and in the app\'s call screen, and leaves them to an app that takes them everywhere else', () => {
    vi.stubGlobal('RTCPeerConnection', function RTCPeerConnection() {});
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => undefined } });
    bridge();
    expect(callSupport()).toBe('page');
    userAgent(`${APP} UniHubCalls`);
    expect(callSupport()).toBe('app');
    // The main WebView at /call is still the main WebView: only the call screen's own runs a call.
    window.history.pushState({}, '', '/call?id=call-1');
    expect(callSupport()).toBe('app');
    userAgent(`${APP} UniHubCallScreen`);
    expect(callSupport()).toBe('page');
    // A level-5 app that cannot take calls (Android 10) runs them in the page while it is open, as older apps do.
    userAgent(APP);
    expect(callSupport()).toBe('page');
    window.history.pushState({}, '', '/');
  });

  it('the main page of an app that takes calls hands a ringing call to the app, and its end once it stops ringing', async () => {
    userAgent(`${APP} UniHubCalls`);
    const sent = bridge();
    const ringing = { id: 'call-1', state: 'ringing', caller_user_id: 'user-blair', callee_user_id: 'user-ada', caller_name: 'Blair Example' } as ChatCall;
    const current = vi.spyOn(chatApi, 'currentCall').mockResolvedValue(ringing);
    const { unmount } = renderHook(() => useHandCallsToApp());
    await waitFor(() => expect(sent).toEqual([{ type: 'call', action: 'ring', id: 'call-1', name: 'Blair Example' }]));
    current.mockResolvedValue(null);
    window.dispatchEvent(new CustomEvent('unihub:chat-call', { detail: 'call-1' }));
    await waitFor(() => expect(sent.at(-1)).toEqual({ type: 'call', action: 'end', id: 'call-1', name: '' }));
    unmount();
  });
});
