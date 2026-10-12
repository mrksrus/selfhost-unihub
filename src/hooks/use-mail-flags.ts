import { isOnline } from '@/lib/platform';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isOfflineMode } from '@/lib/offline';
import { acceptMailCommand, newMailCommand, UnknownMailAcceptance, type MailCommand } from '@/lib/mail-operations';
import { adjustMailUnreadCounts, mailQueryKeys, recordMailFlagEdit, scheduleMailFlagRefresh, type Email, type MailFlagKind, type MailFlagPatch } from '@/lib/mail-api';

const fields = {
  read: { value: 'is_read', pending: 'read_sync_pending' },
  star: { value: 'is_starred', pending: 'star_sync_pending' },
} as const;

type Slot = { email: Email; desired: boolean; confirmed: boolean; shown: boolean; providerPending: boolean; running: boolean; unresolved?: MailCommand; recoveryAttempt?: number; timer?: ReturnType<typeof setTimeout> };

// A field has one HTTP admission in flight. A second (or third) click changes
// desired immediately; the pump sends only the newest value after admission.
// Read and star on the same message are independent fields.
export function useMailFlags(setSelectedEmail: Dispatch<SetStateAction<Email | null>>, onError: (kind: MailFlagKind, message: string, unknown?: boolean) => void) {
  const client = useQueryClient();
  const slots = useRef(new Map<string, Slot>());
  useEffect(() => () => { for (const slot of slots.current.values()) clearTimeout(slot.timer); }, []);
  const [flagRequests, setFlagRequests] = useState(new Set<string>());
  const publish = useCallback((slot: Slot, kind: MailFlagKind, patch: MailFlagPatch, pending: boolean) => {
    const id = slot.email.id;
    recordMailFlagEdit(client, id, kind, patch, pending);
    setSelectedEmail(current => current?.id === id ? { ...current, ...patch } : current);
    // The folder's unread count follows the row at once (and back on rollback).
    const shown = patch.is_read;
    if (kind === 'read' && shown !== undefined && shown !== slot.shown) {
      slot.shown = shown;
      adjustMailUnreadCounts(client, [{ folder: slot.email.folder, accountId: slot.email.mail_account_id, delta: shown ? -1 : 1 }]);
    }
  }, [client, setSelectedEmail]);
  const busy = useCallback(() => setFlagRequests(new Set(slots.current.keys())), []);

  const pump = useCallback(async (key: string, kind: MailFlagKind) => {
    const slot = slots.current.get(key);
    if (!slot || slot.running) return;
    slot.running = true;
    const field = fields[kind];
    try {
      // Never send a later reversal until the previous HTTP outcome is known.
      while (slot.unresolved || slot.confirmed !== slot.desired) {
        const command = slot.unresolved ?? newMailCommand('PUT', `/mail/emails/${encodeURIComponent(slot.email.id)}/${kind}`,
          { [field.value]: slot.desired });
        slot.unresolved = command;
        const value = (command.body as Record<string, boolean>)[field.value];
        try {
          const accepted = await acceptMailCommand(command);
          slot.unresolved = undefined;
          slot.recoveryAttempt = 0;
          slot.confirmed = value;
          slot.providerPending = accepted.sync_pending !== false;
          // Do not let the older acknowledgement repaint a later click.
          if (slot.desired === value) publish(slot, kind,
            { [field.value]: value, [field.pending]: slot.providerPending }, false);
        } catch (error) {
          if (error instanceof UnknownMailAcceptance) {
            // An ambiguous acceptance is not a rejection. Keep its key/body
            // and the visible newest intent; check the same key later.
            slot.recoveryAttempt = (slot.recoveryAttempt ?? 0) + 1;
            if (slot.recoveryAttempt === 1) onError(kind, error.message, true);
            slot.timer = setTimeout(() => { slot.timer = undefined; void pump(key, kind); }, Math.min(30000, 5000 * slot.recoveryAttempt));
            return;
          }
          slot.unresolved = undefined;
          if (slot.desired === value) {
            slot.desired = slot.confirmed;
            publish(slot, kind, { [field.value]: slot.confirmed, [field.pending]: slot.providerPending }, false);
            onError(kind, error instanceof Error ? error.message : 'Change was rejected');
            return;
          }
          // A newer click still needs admission even if the first was rejected.
        }
      }
    } finally {
      slot.running = false;
      if (!slot.unresolved && slot.confirmed === slot.desired) {
        publish(slot, kind, { [field.value]: slot.desired, [field.pending]: slot.providerPending }, false);
        slots.current.delete(key);
        busy();
        // Cached rows and counts already show the accepted value; one
        // coalesced refresh covers the filtered views and the change list.
        scheduleMailFlagRefresh(client, kind);
      }
    }
  }, [busy, client, onError, publish]);

  const requestFlag = useCallback((email: Email, kind: MailFlagKind, value: boolean) => {
    if (isOfflineMode() || !isOnline()) return;
    const key = `${kind}:${email.id}`;
    let slot = slots.current.get(key);
    if (!slot) {
      slot = { email, desired: value, confirmed: email[fields[kind].value], shown: email.is_read, providerPending: email[fields[kind].pending] === true, running: false };
      slots.current.set(key, slot);
    } else slot.desired = value;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = undefined; }
    // Even when a previous HTTP acceptance is in flight, update the reader
    // and all cached lists immediately. No click is silently dropped.
    publish(slot, kind, { [fields[kind].value]: value, [fields[kind].pending]: slot.providerPending }, true);
    busy();
    void client.cancelQueries({ queryKey: mailQueryKeys.all });
    void pump(key, kind);
  }, [busy, client, publish, pump]);

  return { flagRequests, requestFlag };
}
