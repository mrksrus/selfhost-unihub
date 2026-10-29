import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeProvider as Provider, useTheme } from 'next-themes';
import { showThemeInApp } from '@/lib/platform';
import { applyAccent, hslChannelsToHex, readStoredAccent, storeAccent, type AccentId } from '@/lib/accent';
import { applyTheme, readStoredTheme, storeTheme, themeById, type ThemeMode } from '@/lib/theme';
import { AccentContext, type AccentContextValue } from '@/components/theme/use-accent';
import { LookContext, type LookContextValue } from '@/components/theme/use-look';

function ThemeChrome({ accent, looks }: { accent: AccentId; looks: Record<ThemeMode, string> }) {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    // next-themes reports "system" until it has read the device's setting;
    // meanwhile the page keeps the colour public/theme-init.js gave it.
    if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') return;
    const mode: ThemeMode = resolvedTheme === 'light' ? 'light' : 'dark';
    const dark = mode === 'dark';
    const theme = themeById(mode, looks[mode]);
    const background = hslChannelsToHex(applyTheme(mode, theme.id));
    document.documentElement.style.backgroundColor = background;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
    applyAccent(accent, dark, theme);
    showThemeInApp(dark, background);
  }, [resolvedTheme, accent, looks]);
  return null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The device remembers the last accent, so a reload does not start out blue.
  const [accent, setAccentState] = useState<AccentId>(readStoredAccent);
  const value = useMemo<AccentContextValue>(() => ({
    accent,
    setAccent: id => { storeAccent(id); setAccentState(id); },
  }), [accent]);
  const [looks, setLooks] = useState<Record<ThemeMode, string>>(() => ({ dark: readStoredTheme('dark'), light: readStoredTheme('light') }));
  const lookValue = useMemo<LookContextValue>(() => ({
    looks,
    setLook: (mode, id) => { storeTheme(mode, id); setLooks(current => ({ ...current, [mode]: id })); },
  }), [looks]);
  return <Provider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
    <AccentContext.Provider value={value}>
      <LookContext.Provider value={lookValue}>
        <ThemeChrome accent={accent} looks={looks} />{children}
      </LookContext.Provider>
    </AccentContext.Provider>
  </Provider>;
}
