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

/**
 * The open peek can hold back a switch to another email while it has an
 * unsaved reply: the guard returns true and calls `proceed` once the reply is
 * saved or discarded.
 */
type LeaveGuard = (proceed: () => void) => boolean;
let leaveGuard: LeaveGuard | null = null;
export function guardMailPeek(guard: LeaveGuard | null) { leaveGuard = guard; }

/** Shows the email over the page; a peek of another email is replaced. */
export function openMailPeek(emailId: string) {
  const open = () => set({ emailId, docked: false });
  if (state.emailId && state.emailId !== emailId && leaveGuard?.(open)) return;
  open();
}
export function dockMailPeek() { if (state.emailId) set({ ...state, docked: true }); }
export function expandMailPeek() { if (state.emailId) set({ ...state, docked: false }); }
export function closeMailPeek() { set({ emailId: null, docked: false }); }

export function useMailPeek() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
}
