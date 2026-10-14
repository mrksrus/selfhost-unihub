import { createContext, useContext } from 'react';
import type { ThemeMode } from '@/lib/theme';

export interface LookContextValue {
  /** The look chosen on this device for each theme, by id (src/lib/theme.ts). */
  looks: Record<ThemeMode, string>;
  setLook: (mode: ThemeMode, id: string) => void;
}
export const LookContext = createContext<LookContextValue>({ looks: { dark: 'default', light: 'default' }, setLook: () => {} });

export const useLook = () => useContext(LookContext);
