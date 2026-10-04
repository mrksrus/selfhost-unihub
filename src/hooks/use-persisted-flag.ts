import { useCallback, useState } from 'react';

// A true/false choice kept in this browser across reloads (e.g. a collapsed
// sidebar). Storage may be disabled: the default is used then.
export function usePersistedFlag(key: string, defaultValue = false): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? defaultValue : stored === 'true';
    } catch {
      return defaultValue;
    }
  });
  const update = useCallback((next: boolean) => {
    setValue(next);
    try { localStorage.setItem(key, String(next)); } catch { /* Storage may be disabled. */ }
  }, [key]);
  return [value, update];
}
