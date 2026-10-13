import { useContext } from 'react';
import { AuthContext } from './auth-context';

/** The signed-in user's time zone, or null where no session is mounted (browser zone applies). */
export const useUserTimezone = () => useContext(AuthContext)?.user?.timezone ?? null;

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
