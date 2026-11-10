import type { ReactNode } from 'react';
import { AppLockContext, NO_APP_LOCK } from '@/hooks/use-app-lock';

/**
 * The app lock of this device for the signed-in person (hooks/use-app-lock.ts
 * describes what it gives). Mount it inside SessionQueryProvider, which is
 * keyed by the account, around everything that can show private data.
 */
export function AppLockProvider({ children }: { children: ReactNode }) {
  // Contract stub: the logic follows in the next commits.
  return <AppLockContext.Provider value={NO_APP_LOCK}>{children}</AppLockContext.Provider>;
}
