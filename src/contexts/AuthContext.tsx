import React, { useCallback, useEffect, useRef, useState } from 'react';
import { clearOfflineData, isOfflineMode, loadOfflineSession, setOfflineAccount, setOfflineMode } from '@/lib/offline';
import { api } from '@/lib/api';
import { resetBackgroundNotificationState, revokeDevicePushSubscription } from '@/utils/service-worker';
import { AuthContext, type User } from '@/contexts/auth-context';

const AUTH_CHANGE_KEY = 'unihub:auth-change';

function broadcastAuthChange() {
  try { localStorage.setItem(AUTH_CHANGE_KEY, `${Date.now()}:${Math.random()}`); } catch { /* Storage may be disabled. */ }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<{ authenticated: true } | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const [offlineSavedAt, setOfflineSavedAt] = useState<string | undefined>();

  const authVersion = useRef(0);
  const refreshController = useRef<AbortController | null>(null);

  const clearLocalSession = useCallback(() => {
    setUser(null);
    setSession(null);
    api.setCsrfToken(null);
    setOfflineAccount(null);
    setOfflineMode(false);
    setIsOffline(false);
    setOfflineSavedAt(undefined);
  }, []);

  const refreshSession = useCallback(async () => {
    const version = ++authVersion.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    // A cookie may have changed in another tab. Drop the prior user's UI/cache
    // before reading the new identity, never after rendering the new account.
    clearLocalSession();
    setLoading(true);
    try {
      const response = await api.get<{ user: User; csrfToken?: string }>('/auth/me', { signal: controller.signal });
      if (version !== authVersion.current) return;
      if (response.data?.user) {
        const saved = await loadOfflineSession();
        if (version !== authVersion.current) return;
        if (saved && saved.user.id !== response.data.user.id) await clearOfflineData();
        if (version !== authVersion.current) return;
        setOfflineAccount(response.data.user.id);
        api.setCsrfToken(response.data.csrfToken ?? null);
        setUser(response.data.user);
        setSession({ authenticated: true });
      } else if (response.status === 401 || response.status === 403 || (!response.error && !response.data?.user)) {
        try { await clearOfflineData(); } finally { void resetBackgroundNotificationState(); }
      } else if (response.error && response.status === undefined) {
        const saved = await loadOfflineSession();
        if (saved && version === authVersion.current) {
          setOfflineAccount(saved.user.id);
          setOfflineMode(true);
          setIsOffline(true);
          setOfflineSavedAt(saved.savedAt);
          setUser(saved.user);
          setSession({ authenticated: true });
        }
      }
    } catch {
      // An aborted/failed identity check leaves private data inaccessible.
    } finally {
      if (version === authVersion.current) setLoading(false);
    }
  }, [clearLocalSession]);

  useEffect(() => {
    void refreshSession();
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_CHANGE_KEY) void refreshSession();
    };
    window.addEventListener('storage', onStorage);
    const onOnline = () => { if (isOfflineMode()) void refreshSession(); };
    const onSessionExpired = () => { void refreshSession(); };
    const onOfflineMode = async () => {
      const version = authVersion.current;
      setIsOffline(isOfflineMode());
      const saved = await loadOfflineSession();
      if (version === authVersion.current && isOfflineMode()) setOfflineSavedAt(saved?.savedAt);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('unihub:session-expired', onSessionExpired);
    window.addEventListener('unihub-offline-mode', onOfflineMode);
    const onOfflineDataChange = async () => {
      if (!isOfflineMode()) return;
      const version = authVersion.current;
      const saved = await loadOfflineSession();
      if (!saved && version === authVersion.current && isOfflineMode()) clearLocalSession();
    };
    window.addEventListener('unihub-offline-change', onOfflineDataChange);
    window.addEventListener('unihub:retry-session', onSessionExpired);
    const cancelPendingRefresh = () => {
      ++authVersion.current;
      refreshController.current?.abort();
    };
    return () => {
      cancelPendingRefresh();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('unihub:session-expired', onSessionExpired);
      window.removeEventListener('unihub-offline-mode', onOfflineMode);
      window.removeEventListener('unihub-offline-change', onOfflineDataChange);
      window.removeEventListener('unihub:retry-session', onSessionExpired);
    };
  }, [refreshSession, clearLocalSession]);

  const beginAuthentication = () => {
    refreshController.current?.abort();
    setLoading(false);
    return ++authVersion.current;
  };

  const acceptSession = async (nextUser: User, csrfToken: string | undefined, version: number) => {
    const saved = await loadOfflineSession();
    if (version !== authVersion.current) return;
    if (saved && saved.user.id !== nextUser.id) await clearOfflineData();
    if (version !== authVersion.current) return;
    setOfflineAccount(nextUser.id);
    setOfflineMode(false);
    setIsOffline(false);
    setOfflineSavedAt(undefined);
    api.setCsrfToken(csrfToken ?? null);
    setUser(nextUser);
    setSession({ authenticated: true });
    broadcastAuthChange();
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    const version = beginAuthentication();
    const response = await api.post<{ csrfToken?: string; user?: User; requiresApproval?: boolean; message?: string }>('/auth/signup', {
      email,
      password,
      full_name: fullName,
    });

    if (version !== authVersion.current) return { error: new Error('The session changed. Please sign in again.') };
    if (response.error) {
      return { error: new Error(response.error) };
    }

    // If approval is required, account created but not active
    if (response.data?.requiresApproval) {
      return { error: null, requiresApproval: true };
    }

    if (response.data?.user) {
      await acceptSession(response.data.user, response.data.csrfToken, version);
      return { error: null };
    }

    return { error: new Error('Failed to sign up') };
  };

  const signIn = async (email: string, password: string) => {
    const version = beginAuthentication();
    const response = await api.post<{ csrfToken?: string; user?: User; requires2fa?: boolean; challengeToken?: string }>('/auth/signin', {
      email,
      password,
    });

    if (version !== authVersion.current) return { error: new Error('The session changed. Please sign in again.') };
    if (response.error) {
      return { error: new Error(response.error) };
    }

    if (response.data?.requires2fa && response.data.challengeToken) {
      return { error: null, requires2fa: true, challengeToken: response.data.challengeToken };
    }

    if (response.data?.user) {
      await acceptSession(response.data.user, response.data.csrfToken, version);
      return { error: null };
    }

    return { error: new Error('Failed to sign in') };
  };

  const verifyTwoFactorLogin = async (challengeToken: string, code: string) => {
    const version = beginAuthentication();
    const response = await api.post<{
      csrfToken?: string;
      user?: User;
      usedRecoveryCode?: boolean;
      recoveryCodesRemaining?: number;
    }>('/auth/2fa/login', {
      challenge_token: challengeToken,
      code,
    });

    if (version !== authVersion.current) return { error: new Error('The session changed. Please sign in again.') };
    if (response.error) {
      return { error: new Error(response.error) };
    }

    if (response.data?.user) {
      await acceptSession(response.data.user, response.data.csrfToken, version);
      return {
        error: null,
        usedRecoveryCode: response.data.usedRecoveryCode,
        recoveryCodesRemaining: response.data.recoveryCodesRemaining,
      };
    }

    return { error: new Error('Failed to verify authentication code') };
  };

  const signOut = async () => {
    ++authVersion.current;
    refreshController.current?.abort();
    // Unmount all private query observers immediately. Keep CSRF only until the
    // authenticated unsubscribe and signout requests have finished.
    setUser(null);
    setSession(null);
    setLoading(false);
    try {
      try { await revokeDevicePushSubscription(); } catch { /* Still complete local logout. */ }
      await api.post('/auth/signout');
    } finally {
      try { await clearOfflineData(); } finally {
        clearLocalSession();
        void resetBackgroundNotificationState();
        broadcastAuthChange();
      }
    }
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, isOffline, offlineSavedAt, setUser, signUp, signIn, verifyTwoFactorLogin, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};
