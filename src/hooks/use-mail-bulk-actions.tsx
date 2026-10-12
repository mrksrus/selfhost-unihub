import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { invalidateMailMoveViews, mailQueryKeys, showRequestedMoveInMailCaches, type Email, type MailFlagKind, type MovedEmail } from '@/lib/mail-api';
import { acceptMailCommand, newMailCommand, UnknownMailAcceptance } from '@/lib/mail-operations';
import { ALL_MAIL, bulkKey } from '@/components/mail/mail-page-model';

interface BulkOptions {
  /** Messages of the current list, used to find flags and source folders. */
  emails: Email[];
  selectedEmail: Email | null;
  selectedFolder: string;
  requestFlag: (email: Email, kind: MailFlagKind, value: boolean) => void;
  clearSelection: () => void;
  /** Messages that just left the current folder view (the reader closes if it shows one). */
  onMovedAway?: (emailIds: string[]) => void;
}

const messages = (count: number) => count === 1 ? '' : `${count} messages `;

/**
 * Read/star/move/trash for one or more messages. A move or trash shows at
 * once and is rolled back if UniHub rejects it; the server-change list in the
 * sync control carries the provider outcome. An identical request is not sent
 * again while it is in flight; `*Pending` report that for the toolbar.
 */
export function useMailBulkActions({ emails, selectedEmail, selectedFolder, requestFlag, clearSelection, onMovedAway }: BulkOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const bulkRequests = useRef(new Set<string>());
  const [bulkPending, setBulkPending] = useState(new Set<string>());

  const runBulk = useCallback(<T extends object,>(kind: string, payload: T, send: (value: T) => Promise<unknown>) => {
    const key = bulkKey(kind, payload);
    if (bulkRequests.current.has(key)) return;
    bulkRequests.current.add(key);
    setBulkPending(new Set(bulkRequests.current));
    void send(payload).catch(() => { /* Mutation onError displays the API error. */ }).finally(() => {
      bulkRequests.current.delete(key);
      setBulkPending(new Set(bulkRequests.current));
    });
  }, []);

  const findEmail = (id: string) => emails.find(item => item.id === id) || (selectedEmail?.id === id ? selectedEmail : null);

  // Before the request: rows leave the view, counts follow, the selection is
  // done with. Returns the undo for a rejection.
  const showMove = (emailIds: string[], folder: string) => {
    const moved = emailIds.map(findEmail).filter((email): email is Email => !!email && email.folder !== folder) as MovedEmail[];
    void queryClient.cancelQueries({ queryKey: mailQueryKeys.all });
    const undo = showRequestedMoveInMailCaches(queryClient, moved, folder);
    clearSelection();
    if (folder !== selectedFolder && selectedFolder !== ALL_MAIL && selectedFolder !== 'starred') onMovedAway?.(moved.map(email => email.id));
    return undo;
  };

  const bulkMove = useMutation({
    mutationFn: async ({ emailIds, folder, accountId }: { emailIds: string[]; folder: string; accountId?: string; folderLabel?: string }) => {
      const response = await acceptMailCommand(newMailCommand('POST', '/mail/emails/bulk-move', { email_ids: emailIds, folder, account_id: accountId }));
      return response;
    },
    onMutate: ({ emailIds, folder }) => showMove(emailIds, folder),
    onSuccess: (data, variables) => {
      toast({ title: `Moved ${messages(variables.emailIds.length)}to ${variables.folderLabel ?? variables.folder}`,
        description: data?.sync_pending !== false ? 'Waiting for the server' : undefined });
    },
    onError: (error: Error, _variables, undo) => {
      undo?.();
      toast({ title: error instanceof UnknownMailAcceptance ? 'No answer from UniHub yet' : 'Could not move', description: error.message, variant: 'destructive' });
    },
    onSettled: () => { void invalidateMailMoveViews(queryClient); },
  });

  const bulkDelete = useMutation({
    mutationFn: async ({ emailIds }: { emailIds: string[]; restoreFolders: Record<string, string> }) => {
      const response = await acceptMailCommand(newMailCommand('POST', '/mail/emails/bulk-delete', { email_ids: emailIds }));
      return { count: emailIds.length, pending: response.sync_pending !== false };
    },
    onMutate: ({ emailIds }) => showMove(emailIds, 'trash'),
    onSuccess: ({ count, pending }, variables) => {
      toast({
        title: `Moved ${messages(count)}to Trash`,
        description: pending ? 'Waiting for the server' : undefined,
        // A local (Download) move can be undone at once; a provider move is a
        // second MOVE, which the sync panel handles deliberately.
        action: pending ? undefined : (
          <ToastAction
            altText="Undo move to trash"
            onClick={() => {
              const byFolder = Object.entries(variables.restoreFolders).reduce<Record<string, string[]>>((acc, [emailId, folder]) => {
                if (!folder || folder === 'trash') return acc;
                acc[folder] = [...(acc[folder] || []), emailId];
                return acc;
              }, {});
              Object.entries(byFolder).forEach(([folder, emailIds]) => {
                runBulk('move', { emailIds, folder }, bulkMove.mutateAsync);
              });
            }}
          >
            Undo
          </ToastAction>
        ),
      });
    },
    onError: (error: Error, _variables, undo) => {
      undo?.();
      toast({ title: error instanceof UnknownMailAcceptance ? 'No answer from UniHub yet' : 'Could not move to Trash', description: error.message, variant: 'destructive' });
    },
    onSettled: () => { void invalidateMailMoveViews(queryClient); },
  });

  // Bulk flag controls use the same per-email/field admission lanes as row and
  // reader clicks. A slow batch must not overtake a later single-message click.
  const requestBulkFlags = (emailIds: string[], kind: MailFlagKind, value: boolean) => {
    for (const id of emailIds) {
      const email = findEmail(id);
      if (email) requestFlag(email, kind, value);
    }
    clearSelection();
    return Promise.resolve();
  };

  const trashPayload = (emailIds: string[]) => {
    const restoreFolders: Record<string, string> = {};
    for (const id of emailIds) {
      restoreFolders[id] = findEmail(id)?.folder || selectedFolder || 'inbox';
    }
    return { emailIds, restoreFolders };
  };

  return {
    setRead: (emailIds: string[], is_read: boolean) =>
      runBulk('read', { emailIds, is_read }, ({ is_read: value }) => requestBulkFlags(emailIds, 'read', value)),
    star: (emailIds: string[]) =>
      runBulk('star', { emailIds, is_starred: true }, ({ is_starred }) => requestBulkFlags(emailIds, 'star', is_starred)),
    move: (emailIds: string[], folder: string, accountId?: string, folderLabel?: string) =>
      runBulk('move', { emailIds, folder, ...(accountId === undefined ? {} : { accountId }), ...(folderLabel === undefined ? {} : { folderLabel }) }, bulkMove.mutateAsync),
    trash: (emailIds: string[]) => runBulk('delete', trashPayload(emailIds), bulkDelete.mutateAsync),
    readPending: (emailIds: string[], is_read: boolean) => bulkPending.has(bulkKey('read', { emailIds, is_read })),
    starPending: (emailIds: string[]) => bulkPending.has(bulkKey('star', { emailIds, is_starred: true })),
    trashPending: (emailIds: string[]) => bulkPending.has(bulkKey('delete', { emailIds })),
  };
}

export type MailBulkActions = ReturnType<typeof useMailBulkActions>;
