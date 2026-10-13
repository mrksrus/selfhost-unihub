import { useSyncExternalStore } from 'react';

/**
 * The email peek: a message shown over the current page (a task, an event)
 * without leaving it. It can be set aside ("docked") to a small bar while the
 * user works on the page, and brought back with anything written in it.
 */
export interface MailPeekState {
  emailId: string | null;
  docked: boolean;
}

let state: MailPeekState = { emailId: null, docked: false };
const listeners = new Set<() => void>();

function set(next: MailPeekState) {
  state = next;
  listeners.forEach(listener => listener());
}

/** Shows the email over the page; a docked peek of another email is replaced. */
export function openMailPeek(emailId: string) { set({ emailId, docked: false }); }
export function dockMailPeek() { if (state.emailId) set({ ...state, docked: true }); }
export function expandMailPeek() { if (state.emailId) set({ ...state, docked: false }); }
export function closeMailPeek() { set({ emailId: null, docked: false }); }

export function useMailPeek() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
}
