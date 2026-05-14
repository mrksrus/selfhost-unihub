import { createContext } from 'react';

export interface User {
  id: string;
  email: string;
  full_name?: string;
  avatar_url?: string;
  role?: 'user' | 'admin';
  timezone?: string | null;
  two_factor_enabled?: boolean;
}

export interface AuthContextType {
  user: User | null;
  session: { authenticated: true } | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null; requiresApproval?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null; requires2fa?: boolean; challengeToken?: string }>;
  verifyTwoFactorLogin: (challengeToken: string, code: string) => Promise<{ error: Error | null; usedRecoveryCode?: boolean; recoveryCodesRemaining?: number }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);
