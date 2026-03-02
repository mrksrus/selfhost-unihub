import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface User {
  id: string;
  email: string;
  full_name?: string;
  avatar_url?: string;
  role?: 'user' | 'admin';
  timezone?: string | null;
}

interface AuthContextType {
  user: User | null;
  session: { authenticated: true } | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null; requiresApproval?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
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
    const response = await api.post<{ csrfToken?: string; user: User }>('/auth/signin', {
      email,
      password,
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
      return { error: null };
    }

    return { error: new Error('Failed to sign in') };
  };

  const signOut = async () => {
    await api.post('/auth/signout');
    api.setCsrfToken(null);
    setUser(null);
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, setUser, signUp, signIn, signOut }}>
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
