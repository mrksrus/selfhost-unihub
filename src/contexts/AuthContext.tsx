import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface User {
  id: string;
  email: string;
  full_name?: string;
  avatar_url?: string;
  role?: 'user' | 'admin';
}

interface AuthContextType {
  user: User | null;
  session: { token: string } | null;
  loading: boolean;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<{ token: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check for existing session
    const token = localStorage.getItem('auth_token');
    if (token) {
      api.setToken(token);
      // Verify token and get user info
      api.get<{ user: User }>('/auth/me').then((response) => {
        if (response.data?.user) {
          setUser(response.data.user);
          setSession({ token });
        } else {
          // Invalid token, clear it
          api.setToken(null);
          setUser(null);
          setSession(null);
        }
        setLoading(false);
      }).catch(() => {
        api.setToken(null);
        setUser(null);
        setSession(null);
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, []);

  const signUp = async (email: string, password: string, fullName: string) => {
    const response = await api.post<{ token: string; user: User }>('/auth/signup', {
      email,
      password,
      full_name: fullName,
    });

    if (response.error) {
      return { error: new Error(response.error) };
    }

    if (response.data?.token && response.data?.user) {
      api.setToken(response.data.token);
      setUser(response.data.user);
      setSession({ token: response.data.token });
      return { error: null };
    }

    return { error: new Error('Failed to sign up') };
  };

  const signIn = async (email: string, password: string) => {
    const response = await api.post<{ token: string; user: User }>('/auth/signin', {
      email,
      password,
    });

    if (response.error) {
      return { error: new Error(response.error) };
    }

    if (response.data?.token && response.data?.user) {
      api.setToken(response.data.token);
      setUser(response.data.user);
      setSession({ token: response.data.token });
      return { error: null };
    }

    return { error: new Error('Failed to sign in') };
  };

  const signOut = async () => {
    await api.post('/auth/signout');
    api.setToken(null);
    setUser(null);
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signUp, signIn, signOut }}>
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
