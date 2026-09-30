import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { invalidateMailQueries } from '@/lib/mail-api';
import { useToast } from '@/hooks/use-toast';
import type { MailPurgePreview } from '@/components/mail/mail-page-model';

/**
 * Disconnect (keeps local mail) and the separate, guarded purge of a
 * disconnected account. `onPurged` runs after local data was removed.
 */
export function useMailAccountRemoval(onPurged: () => void) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [accountToDelete, setAccountToDelete] = useState<string | null>(null);
  const [accountToPurge, setAccountToPurge] = useState<string | null>(null);
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

  const openPurgePreview = async (id: string) => {
    const request = ++previewRequest.current;
    setAccountToPurge(id);
    setPurgeConfirmation('');
    setPurgePreview(null);
    setPurgePreviewError(null);
    const response = await api.get<MailPurgePreview>(`/mail/accounts/${encodeURIComponent(id)}/purge-preview`);
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
    mutationFn: async (id: string) => {
      const response = await api.delete(`/mail/accounts/${encodeURIComponent(id)}?purge=true&confirm_purge=${encodeURIComponent(id)}`);
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      void invalidateMailQueries(queryClient);
      setAccountToPurge(null);
      setPurgePreview(null);
      onPurged();
      toast({ title: 'Local mail account data purged' });
    },
    onError: (error: Error) => toast({ title: 'Purge blocked', description: error.message, variant: 'destructive' }),
  });

  return {
    accountToDelete, requestDisconnect: setAccountToDelete, cancelDisconnect: () => setAccountToDelete(null), deleteAccount,
    accountToPurge, openPurgePreview, closePurge, purgeConfirmation, setPurgeConfirmation, purgePreview, purgePreviewError, purgeAccount,
  };
}

export type MailAccountRemoval = ReturnType<typeof useMailAccountRemoval>;
