import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { Email } from '@/lib/mail-api';

const NONE: ReadonlySet<string> = new Set();

/**
 * Checked messages of one list view. The selection is stored with the view
 * key (account + folder) it was made in, so it never applies to another view,
 * not even for the render before the reset effect runs.
 */
export function useMailListSelection(viewKey: string, emails: Email[]) {
  const [state, setState] = useState<{ viewKey: string; ids: ReadonlySet<string> }>({ viewKey, ids: NONE });
  const selectedEmails = state.viewKey === viewKey ? state.ids : NONE;
  const setSelectedEmails = useCallback((ids: ReadonlySet<string>) => setState({ viewKey, ids }), [viewKey]);
  const clearSelection = useCallback(() => setState({ viewKey, ids: new Set() }), [viewKey]);

  // Returning to an earlier view starts without its old selection.
  useEffect(() => { setState({ viewKey, ids: new Set() }); }, [viewKey]);

  const toggleEmail = (emailId: string, e: MouseEvent) => {
    e.stopPropagation();
    const newSelected = new Set(selectedEmails);
    if (newSelected.has(emailId)) {
      // Already selected: deselect it
      newSelected.delete(emailId);
    } else if (e.shiftKey && selectedEmails.size > 0) {
      // Shift+Click: select range
      const emailIds = emails.map(email => email.id);
      const startIdx = emailIds.findIndex(id => selectedEmails.has(id));
      const endIdx = emailIds.findIndex(id => id === emailId);
      if (startIdx !== -1 && endIdx !== -1) {
        const start = Math.min(startIdx, endIdx);
        const end = Math.max(startIdx, endIdx);
        for (let i = start; i <= end; i++) {
          newSelected.add(emailIds[i]);
        }
      } else {
        newSelected.add(emailId);
      }
    } else {
      // Regular click or Ctrl+Click: add to the existing selection
      newSelected.add(emailId);
    }
    setSelectedEmails(newSelected);
  };

  const toggleAll = () => {
    if (selectedEmails.size === emails.length) {
      clearSelection();
    } else {
      setSelectedEmails(new Set(emails.map(email => email.id)));
    }
  };

  const selectedIds = useMemo(() => Array.from(selectedEmails), [selectedEmails]);
  return { selectedEmails, selectedIds, setSelectedEmails, clearSelection, toggleEmail, toggleAll };
}

export type MailListSelection = ReturnType<typeof useMailListSelection>;

/** Delete, Ctrl/Cmd+A and Escape for the list, ignored while typing. */
export function useMailListShortcuts(selection: MailListSelection, emails: Email[], onDelete: (emailIds: string[]) => void) {
  const { selectedEmails, setSelectedEmails, clearSelection } = selection;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'Delete' && selectedEmails.size > 0) {
        e.preventDefault();
        onDelete(Array.from(selectedEmails));
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        if (emails.length > 0) {
          setSelectedEmails(new Set(emails.map(email => email.id)));
        }
      }

      if (e.key === 'Escape') {
        clearSelection();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedEmails, emails, onDelete, setSelectedEmails, clearSelection]);
}
