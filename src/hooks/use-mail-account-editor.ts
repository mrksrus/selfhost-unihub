import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { MailAccount } from '@/lib/mail-api';
import { useToast } from '@/hooks/use-toast';
import { browserTimeZone } from '@/lib/calendar-api';
import { accountSyncWindow, accountTrashWindow, useMailModeImpact } from '@/hooks/use-mail-mode-impact';
import {
  calendarSubscriptionHints, initialAccountForm, mailProviders,
  type AccountFormState, type AddMailAccountResponse, type MailHostTrustError, type MailHostTrustResult, type PendingHostTrust,
} from '@/components/mail/mail-page-model';

const createHostTrustError = (message: string, mailHostTrust?: unknown) => {
  const error = new Error(message) as MailHostTrustError;
  error.requiresHostTrustConfirmation = true;
  error.mailHostTrust = mailHostTrust as MailHostTrustResult | undefined;
  return error;
};

// The API refuses a switch to Sync without the typed account address.
type ConfirmationError = Error & { requiresConfirmation?: boolean };
const isConfirmationError = (error: Error): error is ConfirmationError => (error as ConfirmationError).requiresConfirmation === true;

const isHostTrustError = (error: Error): error is MailHostTrustError => (
  Boolean((error as MailHostTrustError).requiresHostTrustConfirmation && (error as MailHostTrustError).mailHostTrust)
);

/** State and requests of the add/edit mail account dialog, including the host trust review step. */
export function useMailAccountEditor() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<MailAccount | null>(null);
  const [accountForm, setAccountForm] = useState<AccountFormState>(initialAccountForm);
  const [pendingHostTrust, setPendingHostTrust] = useState<PendingHostTrust | null>(null);
  const [typedAddress, setTypedAddress] = useState('');
  const [serverRequiresConfirmation, setServerRequiresConfirmation] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const modeReview = useMailModeImpact({
    account: editingAccount, mode: accountForm.sync_mode, syncWindow: accountForm.sync_window_days,
    trashWindow: accountForm.trash_window_days, typedAddress, serverRequiresConfirmation,
  });

  // The backend verifies host safety, certificate trust, then IMAP auth.
  const addAccount = useMutation({
    mutationFn: async (account: AccountFormState & { accept_host_trust?: boolean }) => {
      // Providers without CalDAV only get a calendar when a subscription address was pasted.
      const tryCalendar = account.try_calendar_sync && (!calendarSubscriptionHints[account.provider] || account.caldav_url.trim() !== '');
      const response = await api.post<AddMailAccountResponse>('/mail/accounts', {
        ...account,
        try_calendar_sync: tryCalendar,
        time_zone: browserTimeZone(),
        encrypted_password: account.password, // Will be encrypted on server
      });
      if (response.status === 409 && response.requiresHostTrustConfirmation) {
        throw createHostTrustError(response.error || 'Review mail server authenticity before continuing.', response.mailHostTrust);
      }
      if (response.error) throw new Error(response.error);
      return response.data ?? {};
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts-count'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['calendar-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['calendar-calendars'] });
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['mail-calendar'] });
      setPendingHostTrust(null);

      const syncMsg = data?.syncInProgress
        ? data.message || 'Syncing emails in the background. First sync will take a long time.'
        : 'Account connected successfully';

      toast({
        title: '✓ Account connected successfully',
        description: syncMsg,
        duration: 10000,
      });
      if (data.calendarSync?.attempted) {
        if (data.calendarSync.success) {
          const count = data.calendarSync.calendars ?? 0;
          const server = data.calendarSync.server?.label;
          toast({
            title: 'Calendar connected',
            description: `${count} calendar${count === 1 ? '' : 's'}${server ? ` on ${server}` : ''}. Events appear as the first sync finishes.`,
          });
        } else {
          toast({
            title: 'Mail connected, calendar not connected',
            description: `${data.calendarSync.warning || 'The calendar server was not found.'} You can change this later in the account settings.`,
            variant: 'destructive',
            duration: 10000,
          });
        }
      }

      setIsOpen(false);
      setAccountForm(initialAccountForm);
    },
    onError: (error: Error, variables) => {
      if (isHostTrustError(error)) {
        setPendingHostTrust({ mode: 'add', account: variables, trust: error.mailHostTrust! });
        return;
      }
      toast({
        title: 'Failed to add mail account',
        description: error.message,
        variant: 'destructive',
        duration: 8000,
      });
    },
  });

  const updateAccount = useMutation({
    mutationFn: async ({ id, ...data }: { id: string; is_active?: boolean; confirm_address?: string; sync_mode_confirmed?: boolean } & Partial<AccountFormState> & { accept_host_trust?: boolean }) => {
      const response = await api.put(`/mail/accounts/${id}`, {
        ...data,
        encrypted_password: data.password || undefined,
      });
      if (response.status === 400 && response.requires_confirmation === true) {
        throw Object.assign(new Error(response.error || 'Type the account address to confirm this change.'), { requiresConfirmation: true });
      }
      if (response.status === 409 && response.requiresHostTrustConfirmation) {
        throw createHostTrustError(response.error || 'Review mail server authenticity before continuing.', response.mailHostTrust);
      }
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      // A new password or a disconnect also resumes or pauses the linked calendar.
      queryClient.invalidateQueries({ queryKey: ['mail-calendar'] });
      queryClient.invalidateQueries({ queryKey: ['calendar-accounts'] });
      setPendingHostTrust(null);
      toast({ title: '✓ Account updated successfully' });
      resetForm();
      setIsOpen(false);
    },
    onError: (error: Error, variables) => {
      if (isHostTrustError(error)) {
        setPendingHostTrust({ mode: 'edit', accountId: variables.id, account: { ...accountForm, ...variables }, trust: error.mailHostTrust! });
        return;
      }
      // Keep every edit; show the reason next to the confirmation it needs.
      setSaveError(error.message);
      if (isConfirmationError(error)) setServerRequiresConfirmation(true);
      toast({
        title: 'Failed to update account',
        description: error.message,
        variant: 'destructive'
      });
    },
  });

  const resetForm = () => {
    setEditingAccount(null);
    setAccountForm(initialAccountForm);
    setPendingHostTrust(null);
    setTypedAddress('');
    setServerRequiresConfirmation(false);
    setSaveError(null);
  };

  const onOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) resetForm();
  };

  /** Mode and window edits invalidate an earlier typed confirmation: the counts it confirmed may differ. */
  const changeModeChoice = (patch: Partial<Pick<AccountFormState, 'sync_mode' | 'sync_window_days' | 'trash_window_days' | 'delete_emails_on_server'>>) => {
    setAccountForm(form => ({ ...form, ...patch }));
    if (patch.sync_mode !== undefined || patch.sync_window_days !== undefined || patch.trash_window_days !== undefined) {
      setTypedAddress('');
      setServerRequiresConfirmation(false);
      setSaveError(null);
    }
  };

  // Sent with every confirmed change; the API requires it to switch to Sync.
  const confirmation = () => modeReview.requiresAddress && modeReview.addressOk
    ? { confirm_address: typedAddress.trim(), ...(modeReview.switchingToSync || serverRequiresConfirmation ? { sync_mode_confirmed: true } : {}) }
    : {};

  const changeProvider = (provider: string) => {
    const providerConfig = mailProviders.find(p => p.value === provider);
    setAccountForm({
      ...accountForm,
      provider,
      imap_host: providerConfig?.imapHost || '',
      smtp_host: providerConfig?.smtpHost || '',
      imap_port: providerConfig?.imapPort || 993,
      smtp_port: providerConfig?.smtpPort || 587,
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (editingAccount) {
      if (modeReview.blocked) return;
      setSaveError(null);
      updateAccount.mutate({ id: editingAccount.id, ...accountForm, ...confirmation(),
        // A restore pauses accounts without disconnecting them; a new password reconnects both.
        ...((editingAccount.disconnected_at || !editingAccount.is_active) && accountForm.password ? { is_active: true } : {}) });
    } else {
      addAccount.mutate(accountForm);
    }
  };

  const confirmHostTrust = () => {
    if (!pendingHostTrust) return;
    if (pendingHostTrust.mode === 'edit' && pendingHostTrust.accountId) {
      updateAccount.mutate({
        id: pendingHostTrust.accountId,
        ...pendingHostTrust.account,
        ...confirmation(),
        accept_host_trust: true,
      });
    } else {
      addAccount.mutate({
        ...pendingHostTrust.account,
        accept_host_trust: true,
      });
    }
    setPendingHostTrust(null);
  };

  const startEdit = (account: MailAccount) => {
    setEditingAccount(account);
    setAccountForm({
      email_address: account.email_address,
      display_name: account.display_name || '',
      provider: account.provider,
      username: account.username || account.email_address,
      password: '',
      imap_host: account.imap_host || '',
      smtp_host: account.smtp_host || '',
      imap_port: account.imap_port || 993,
      smtp_port: account.smtp_port || 587,
      sync_fetch_limit: account.sync_fetch_limit || 'all',
      sync_mode: account.sync_mode || 'download',
      sync_window_days: accountSyncWindow(account),
      trash_window_days: accountTrashWindow(account),
      delete_emails_on_server: account.delete_emails_on_server === true,
      try_calendar_sync: false,
      caldav_url: '',
    });
    setTypedAddress('');
    setServerRequiresConfirmation(false);
    setSaveError(null);
    setIsOpen(true);
  };

  return {
    isOpen, onOpenChange, openAdd: () => setIsOpen(true), close: () => setIsOpen(false),
    editingAccount, startEdit, accountForm, setAccountForm, changeProvider, submit,
    pendingHostTrust, confirmHostTrust, denyHostTrust: () => setPendingHostTrust(null),
    isSaving: addAccount.isPending || updateAccount.isPending,
    changeModeChoice, modeReview, typedAddress, setTypedAddress, saveError,
  };
}

export type MailAccountEditor = ReturnType<typeof useMailAccountEditor>;
