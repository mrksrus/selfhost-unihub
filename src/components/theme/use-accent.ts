import { createContext, useContext } from 'react';
import type { AccentId } from '@/lib/accent';

export interface AccentContextValue { accent: AccentId; setAccent: (id: AccentId) => void }
export const AccentContext = createContext<AccentContextValue>({ accent: 'blue', setAccent: () => {} });

/** The accent in force. Signed in, PreferenceAccent keeps it in step with the saved preference. */
export const useAccent = () => useContext(AccentContext);
