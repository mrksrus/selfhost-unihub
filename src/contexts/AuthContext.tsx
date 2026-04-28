import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { resetBackgroundNotificationState } from '@/utils/service-worker';

interface User {
  id: string;
  email: string;
  full_name?: string;
  avatar_url?: string;
  role?: 'user' | 'admin';
  timezone?: string | null;
  two_factor_enabled?: boolean;
}

interface AuthContextType {
  user: User | null;
  session: { authenticated: true } | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null; requiresApproval?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null; requires2fa?: boolean; challengeToken?: string }>;
  verifyTwoFactorLogin: (challengeToken: string, code: string) => Promise<{ error: Error | null; usedRecoveryCode?: boolean; recoveryCodesRemaining?: number }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<{ authenticated: true } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<{ user: User; csrfToken?: string }>('/auth/me').then((response) => {
      if (response.data?.user) {
        setUser(response.data.user);
        setSession({ authenticated: true });
        if (response.data.csrfToken) {
          api.setCsrfToken(response.data.csrfToken);
        }
      } else {
        setUser(null);
        setSession(null);
      }
      setLoading(false);
    }).catch(() => {
      setUser(null);
      setSession(null);
      setLoading(false);
    });
  }, []);

  const signUp = async (email: string, password: string, fullName: string) => {
    const response = await api.post<{ csrfToken?: string; user?: User; requiresApproval?: boolean; message?: string }>('/auth/signup', {
      email,
      password,
      full_name: fullName,
    });

    if (response.error) {
      return { error: new Error(response.error) };
    }

    // If approval is required, account created but not active
    if (response.data?.requiresApproval) {
      return { error: null, requiresApproval: true };
    }

    if (response.data?.user) {
      if (response.data.csrfToken) {
        api.setCsrfToken(response.data.csrfToken);
      }
      setUser(response.data.user);
      setSession({ authenticated: true });
      return { error: null };
    }

    return { error: new Error('Failed to sign up') };
  };

  const signIn = async (email: string, password: string) => {
    const response = await api.post<{ csrfToken?: string; user?: User; requires2fa?: boolean; challengeToken?: string }>('/auth/signin', {
      email,
      password,
    });

    if (response.error) {
      return { error: new Error(response.error) };
    }

    if (response.data?.requires2fa && response.data.challengeToken) {
      return { error: null, requires2fa: true, challengeToken: response.data.challengeToken };
    }

    if (response.data?.user) {
      if (response.data.csrfToken) {
        api.setCsrfToken(response.data.csrfToken);
      }
      setUser(response.data.user);
      setSession({ authenticated: true });
      return { error: null };
    }

    return { error: new Error('Failed to sign in') };
  };

  const verifyTwoFactorLogin = async (challengeToken: string, code: string) => {
    const response = await api.post<{
      csrfToken?: string;
      user?: User;
      usedRecoveryCode?: boolean;
      recoveryCodesRemaining?: number;
    }>('/auth/2fa/login', {
      challenge_token: challengeToken,
      code,
    });

    if (response.error) {
      return { error: new Error(response.error) };
    }

    if (response.data?.user) {
      if (response.data.csrfToken) {
        api.setCsrfToken(response.data.csrfToken);
      }
      setUser(response.data.user);
      setSession({ authenticated: true });
      return {
        error: null,
        usedRecoveryCode: response.data.usedRecoveryCode,
        recoveryCodesRemaining: response.data.recoveryCodesRemaining,
      };
    }

    return { error: new Error('Failed to verify authentication code') };
  };

  const signOut = async () => {
    await api.post('/auth/signout');
    void resetBackgroundNotificationState();
    api.setCsrfToken(null);
    setUser(null);
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, setUser, signUp, signIn, verifyTwoFactorLogin, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
