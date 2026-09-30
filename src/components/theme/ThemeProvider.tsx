import { useEffect, type ReactNode } from 'react';
import { ThemeProvider as Provider, useTheme } from 'next-themes';

function ThemeChrome() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    const dark = resolvedTheme !== 'light';
    document.documentElement.style.backgroundColor = dark ? '#000000' : '#f5f7fa';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#2563eb');
  }, [resolvedTheme]);
  return null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  return <Provider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
    <ThemeChrome />{children}
  </Provider>;
}
