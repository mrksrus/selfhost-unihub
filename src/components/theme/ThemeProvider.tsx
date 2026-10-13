import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeProvider as Provider, useTheme } from 'next-themes';
import { applyAccent, readStoredAccent, storeAccent, type AccentId } from '@/lib/accent';
import { AccentContext, type AccentContextValue } from '@/components/theme/use-accent';

function ThemeChrome({ accent }: { accent: AccentId }) {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    const dark = resolvedTheme !== 'light';
    document.documentElement.style.backgroundColor = dark ? '#000000' : '#f5f7fa';
    applyAccent(accent, dark);
  }, [resolvedTheme, accent]);
  return null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The device remembers the last accent, so a reload does not start out blue.
  const [accent, setAccentState] = useState<AccentId>(readStoredAccent);
  const value = useMemo<AccentContextValue>(() => ({
    accent,
    setAccent: id => { storeAccent(id); setAccentState(id); },
  }), [accent]);
  return <Provider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
    <AccentContext.Provider value={value}>
      <ThemeChrome accent={accent} />{children}
    </AccentContext.Provider>
  </Provider>;
}
