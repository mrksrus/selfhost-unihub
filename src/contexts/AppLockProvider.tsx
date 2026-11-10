import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { AppLockContext, NO_APP_LOCK, type AppLockArea, type AppLockValue } from '@/hooks/use-app-lock';
import { AppLockController, type AppLockSnapshot } from '@/lib/app-lock/controller';
import { covers } from '@/lib/app-lock/timeline';

/**
 * The app lock of this device for the signed-in person (hooks/use-app-lock.ts
 * describes what it gives; lib/app-lock/controller.ts decides). Mount it
 * inside SessionQueryProvider, which is keyed by the account, around
 * everything that can show private data. The lock covers the saved offline
 * copy too: a cold start offline asks before the copy is shown.
 */
export function AppLockProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <AppLockContext.Provider value={NO_APP_LOCK}>{children}</AppLockContext.Provider>;
  return <SignedInAppLock key={user.id} userId={user.id}>{children}</SignedInAppLock>;
}

function SignedInAppLock({ userId, children }: { userId: string; children: ReactNode }) {
  const { signOut } = useAuth();
  const client = useQueryClient();
  // The auth provider makes a new signOut each render; the controller calls the latest.
  const latestSignOut = useRef(signOut);
  useEffect(() => { latestSignOut.current = signOut; }, [signOut]);
  const [controller, setController] = useState<AppLockController | null>(null);
  const [snapshot, setSnapshot] = useState<AppLockSnapshot | null>(null);

  useEffect(() => {
    // Made here rather than in state, so a remount (React's strict checks)
    // gets a controller of its own and the ended one answers nothing.
    const next = new AppLockController({
      userId,
      signOut: () => latestSignOut.current(),
      // What was refused while the device fell short: fetch it again.
      onCompliant: () => { void client.invalidateQueries(); },
    });
    setController(next);
    setSnapshot(next.getSnapshot());
    const unsubscribe = next.subscribe(() => setSnapshot(next.getSnapshot()));
    void next.start();
    return () => { unsubscribe(); next.stop(); };
  }, [userId, client]);

  // After the page shows the outcome of a check (a lock screen or an open
  // view), the Android app lifts its cover; on the web the blur goes.
  const checks = snapshot?.checks;
  const settled = !!snapshot && snapshot.status !== 'checking';
  useEffect(() => {
    if (settled) void controller?.release();
  }, [controller, checks, settled]);

  const value = useMemo<AppLockValue>(() => {
    if (!controller || !snapshot) return { ...NO_APP_LOCK, status: 'checking', locked: () => true };
    const { checks: _checks, ...state } = snapshot;
    const locked = (area: AppLockArea) => state.status === 'checking'
      || ((state.status === 'locked' || state.status === 'setup') && (area === 'app' ? state.scope.includes('app') : covers(state.scope, area)));
    return {
      ...state,
      locked,
      unlock: controller.unlock,
      confirm: controller.confirm,
      lockNow: controller.lockNow,
      setPin: controller.setPin,
      saveSettings: controller.saveSettings,
      signOut: controller.signOut,
    };
  }, [controller, snapshot]);

  return <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>;
}
