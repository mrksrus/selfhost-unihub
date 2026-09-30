import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { invalidateMailQueries, type Email, type MailFlagKind } from '@/lib/mail-api';
import { acceptMailCommand, newMailCommand, UnknownMailAcceptance } from '@/lib/mail-operations';
import { bulkKey } from '@/components/mail/mail-page-model';

interface BulkOptions {
  /** Messages of the current list, used to find flags and source folders. */
  emails: Email[];
  selectedEmail: Email | null;
  selectedFolder: string;
  requestFlag: (email: Email, kind: MailFlagKind, value: boolean) => void;
  clearSelection: () => void;
}

/**
 * Read/star/move/trash for one or more messages. An identical request is not
 * sent again while it is in flight; `*Pending` report that for the toolbar.
 */
export function useMailBulkActions({ emails, selectedEmail, selectedFolder, requestFlag, clearSelection }: BulkOptions) {
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

  const bulkMove = useMutation({
    mutationFn: async ({ emailIds, folder, accountId }: { emailIds: string[]; folder: string; accountId?: string }) => {
      const response = await acceptMailCommand(newMailCommand('POST', '/mail/emails/bulk-move', { email_ids: emailIds, folder, account_id: accountId }));
      return response;
    },
    onSuccess: (data, variables) => {
      void invalidateMailQueries(queryClient);
      clearSelection();
      toast({ title: `Move accepted for ${variables.emailIds.length} email(s)`,
        description: data?.sync_pending !== false ? 'Provider confirmation is pending. The sync button shows the outcome.' : 'The local request was accepted; provider confirmation is not implied.' });
    },
    onError: (error: Error) => {
      toast({ title: error instanceof UnknownMailAcceptance ? 'Move outcome unknown — do not resend' : 'Move request rejected', description: error.message, variant: 'destructive' });
    },
  });

  const bulkDelete = useMutation({
    mutationFn: async ({ emailIds }: { emailIds: string[]; restoreFolders: Record<string, string> }) => {
      const response = await acceptMailCommand(newMailCommand('POST', '/mail/emails/bulk-delete', { email_ids: emailIds }));
      return { count: emailIds.length, pending: response.sync_pending !== false };
    },
    onSuccess: ({ count, pending }, variables) => {
      void invalidateMailQueries(queryClient);
      clearSelection();
      toast({
        title: pending ? `Trash move saved for ${count} email(s)` : `Trash request accepted for ${count} email(s)`,
        description: pending ? 'Server changes are waiting to sync. The sync button shows their progress.' : undefined,
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
    onError: (error: Error) => {
      toast({ title: error instanceof UnknownMailAcceptance ? 'Trash request outcome unknown' : 'Trash request rejected', description: error.message, variant: 'destructive' });
    },
  });

  const findEmail = (id: string) => emails.find(item => item.id === id) || (selectedEmail?.id === id ? selectedEmail : null);

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
    move: (emailIds: string[], folder: string, accountId?: string) =>
      runBulk('move', accountId === undefined ? { emailIds, folder } : { emailIds, folder, accountId }, bulkMove.mutateAsync),
    trash: (emailIds: string[]) => runBulk('delete', trashPayload(emailIds), bulkDelete.mutateAsync),
    readPending: (emailIds: string[], is_read: boolean) => bulkPending.has(bulkKey('read', { emailIds, is_read })),
    starPending: (emailIds: string[]) => bulkPending.has(bulkKey('star', { emailIds, is_starred: true })),
    trashPending: (emailIds: string[]) => bulkPending.has(bulkKey('delete', { emailIds })),
  };
}

export type MailBulkActions = ReturnType<typeof useMailBulkActions>;
