import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { invalidateMailQueries } from '@/lib/mail-api';
import { useToast } from '@/hooks/use-toast';
import type { MailPurgePreview } from '@/components/mail/mail-page-model';

/**
 * Disconnect (keeps local mail) and the guarded purge of the account's local
 * data: mail, attachments and its linked calendar. A disconnected account is
 * purged on its own; a connected one is disconnected and purged in one step
 * (`purgeDisconnects`). `onPurged` runs after local data was removed.
 */
export function useMailAccountRemoval(onPurged: () => void) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [accountToDelete, setAccountToDelete] = useState<string | null>(null);
  const [accountToPurge, setAccountToPurge] = useState<string | null>(null);
  const [purgeDisconnects, setPurgeDisconnects] = useState(false);
  const [purgeConfirmation, setPurgeConfirmation] = useState('');
  const [purgePreview, setPurgePreview] = useState<MailPurgePreview | null>(null);
  const [purgePreviewError, setPurgePreviewError] = useState<string | null>(null);
  // A preview requested for an earlier account must not fill a later dialog.
  const previewRequest = useRef(0);

  const deleteAccount = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.delete(`/mail/accounts/${encodeURIComponent(id)}`);
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-sync-jobs'] });
      setAccountToDelete(null);
      toast({ title: 'Mail account disconnected', description: 'Your local mail is retained. Reconnect in account settings with credentials.' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to disconnect account', description: error.message, variant: 'destructive' });
    },
  });

  const openPurgePreview = async (id: string, { disconnect = false } = {}) => {
    const request = ++previewRequest.current;
    setAccountToDelete(null);
    setAccountToPurge(id);
    setPurgeDisconnects(disconnect);
    setPurgeConfirmation('');
    setPurgePreview(null);
    setPurgePreviewError(null);
    const response = await api.get<MailPurgePreview>(`/mail/accounts/${encodeURIComponent(id)}/purge-preview${disconnect ? '?disconnect=true' : ''}`);
    if (request !== previewRequest.current) return;
    if (response.error || !response.data || response.data.account_id !== id) {
      setPurgePreviewError(response.error || 'Could not verify the purge preview.');
      return;
    }
    setPurgePreview(response.data);
  };

  const closePurge = () => {
    ++previewRequest.current;
    setAccountToPurge(null);
    setPurgePreview(null);
  };

  const purgeAccount = useMutation({
    mutationFn: async ({ id, disconnect }: { id: string; disconnect: boolean }) => {
      const response = await api.delete(`/mail/accounts/${encodeURIComponent(id)}?purge=true${disconnect ? '&disconnect=true' : ''}&confirm_purge=${encodeURIComponent(id)}`);
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      void invalidateMailQueries(queryClient);
      setAccountToPurge(null);
      setPurgePreview(null);
      onPurged();
      toast({ title: 'Local mail account data deleted' });
    },
    onError: (error: Error) => {
      // A refused one-step delete may already have disconnected the account.
      void queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      toast({ title: 'Delete blocked', description: error.message, variant: 'destructive' });
    },
  });

  return {
    accountToDelete, requestDisconnect: setAccountToDelete, cancelDisconnect: () => setAccountToDelete(null), deleteAccount,
    accountToPurge, purgeDisconnects, openPurgePreview, closePurge, purgeConfirmation, setPurgeConfirmation, purgePreview, purgePreviewError, purgeAccount,
  };
}

export type MailAccountRemoval = ReturnType<typeof useMailAccountRemoval>;
