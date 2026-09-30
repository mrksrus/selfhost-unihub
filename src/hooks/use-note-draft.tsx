import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { NoteDetail } from '@/lib/notes-api';
export type NoteDraft = { detail: NoteDetail | null; title: string; body: string; links: string[] };
export const emptyNoteDraft = (): NoteDraft => ({ detail: null, title: '', body: '', links: [] });
export function noteDraftDirty(draft: NoteDraft) {
  return draft.title !== (draft.detail?.note.title || '') || draft.body !== (draft.detail?.note.body || '') || JSON.stringify([...draft.links].sort()) !== JSON.stringify((draft.detail?.links || []).map(link => link.id).sort());
}
const Context = createContext<{ draft: NoteDraft; setDraft: React.Dispatch<React.SetStateAction<NoteDraft>>; busy: boolean; setBusy: React.Dispatch<React.SetStateAction<boolean>> } | null>(null);
// Session-local memory survives navigation without writing private notes into browser storage.
export function NoteDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<NoteDraft>(emptyNoteDraft);
  const [busy, setBusy] = useState(false);
  const dirty = noteDraftDirty(draft);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return <Context.Provider value={{ draft, setDraft, busy, setBusy }}>{children}</Context.Provider>;
}
export function useNoteDraft() {
  const context = useContext(Context);
  if (!context) throw new Error('Notes require the session draft provider.');
  return context;
}
