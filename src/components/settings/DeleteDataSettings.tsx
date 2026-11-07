import { useState } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { deleteOwnAccount } from '@/lib/auth-api';
import type { ModuleId } from '@/lib/modules';
import { invalidateCalendarQueries } from '@/lib/calendar-api';
import { invalidateContactQueries } from '@/lib/contacts-api';
import { invalidateMailQueries } from '@/lib/mail-api';
import { recordingsQueryKeys } from '@/lib/recordings-api';
import { senderCandidatesQueryKey } from '@/lib/mail-rules-api';
import { useModules } from '@/hooks/use-modules';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import { usePolicy } from '@/hooks/use-policies';
import { useSecretMutation } from '@/hooks/use-secret-mutation';

interface Target {
  id: string;
  module?: ModuleId;
  label: string;
  description: string;
  confirm: string;
  consequence: string;
  path: string;
  done: string;
  refresh?: (client: QueryClient) => unknown;
}

const TARGETS: Target[] = [
  { id: 'contacts', module: 'contacts', label: 'Contacts', description: '', confirm: 'Delete all contacts?',
    consequence: 'Every contact is deleted. This cannot be undone.', path: '/settings/clear-contacts', done: 'All contacts deleted',
    refresh: invalidateContactQueries },
  { id: 'calendar', module: 'calendar', label: 'Calendar and ToDo', description: '', confirm: 'Delete all events and tasks?',
    consequence: 'Every calendar event and task is deleted. This cannot be undone.', path: '/settings/clear-calendar', done: 'All events and tasks deleted',
    refresh: invalidateCalendarQueries },
  { id: 'mail', module: 'mail', label: 'Mail accounts', description: 'Mail on your mail servers is not touched.', confirm: 'Delete all mail accounts?',
    consequence: 'Every mail account and its mail in UniHub is deleted. Mail on your mail servers is not touched. This cannot be undone.',
    path: '/settings/clear-mail-accounts', done: 'All mail accounts deleted',
    refresh: client => Promise.all([invalidateMailQueries(client), client.invalidateQueries({ queryKey: senderCandidatesQueryKey })]) },
  { id: 'recordings', module: 'recordings', label: 'Recordings', description: '', confirm: 'Delete all recordings?',
    consequence: 'Every recording and its audio file is deleted. This cannot be undone.', path: '/settings/clear-recordings', done: 'All recordings deleted',
    refresh: client => client.invalidateQueries({ queryKey: recordingsQueryKeys.all }) },
];

// Deleting the account asks for the password again (D41), as every action
// on an account through the admin path does.
const ACCOUNT_CONSEQUENCE = 'Your account and all of its UniHub data are deleted permanently: mail copies, contacts, calendars, tasks, recordings and backups kept on this server. This cannot be undone.';

export default function DeleteDataSettings() {
  const client = useQueryClient();
  const { toast } = useToast();
  const { isEnabled } = useModules();
  const [target, setTarget] = useState<Target | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  // Greyed with the policy's reason (F13); the server refuses the request anyway.
  const clearPolicy = usePolicy('data.clear');
  const accountPolicy = usePolicy('account.delete');

  const remove = useMutation({
    mutationFn: async (entry: Target) => {
      const response = await api.post<{ message?: string }>(entry.path);
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (data, entry) => {
      void entry.refresh?.(client);
      toast({ title: data?.message || entry.done });
      setTarget(null);
    },
    onError: (error: Error, entry) => toast({ title: `Could not delete ${entry.label.toLowerCase()}`, description: error.message, variant: 'destructive' }),
  });
  // The password is a variable of the request only while it runs (useSecretMutation).
  const removeAccount = useSecretMutation({
    mutationFn: (currentPassword: string) => deleteOwnAccount(currentPassword),
    onSuccess: () => { window.location.assign('/auth'); },
    onError: (error: Error) => toast({ title: 'Could not delete your account', description: error.message, variant: 'destructive' }),
  });

  return (
    <>
      <SettingsSection title="Delete data" description="Only a backup can bring it back.">
        {TARGETS.filter(entry => !entry.module || isEnabled(entry.module)).map(entry => (
          <SettingsRow key={entry.id} label={entry.label} description={entry.description || undefined} lock={clearPolicy.lock}>
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setTarget(entry)} disabled={!!clearPolicy.lock}>Delete all</Button>
          </SettingsRow>
        ))}
      </SettingsSection>
      <SettingsSection title="Account">
        <SettingsRow label="Delete your account" description="Asks for your password." tone="destructive" lock={accountPolicy.lock}>
          <Button variant="destructive" onClick={() => setDeletingAccount(true)} disabled={!!accountPolicy.lock}>Delete account</Button>
        </SettingsRow>
      </SettingsSection>

      <AlertDialog open={!!target} onOpenChange={open => { if (!open && !remove.isPending) setTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{target?.confirm}</AlertDialogTitle>
            <AlertDialogDescription>{target?.consequence}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} disabled={remove.isPending}
              onClick={event => { event.preventDefault(); if (target) remove.mutate(target); }}>
              {remove.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PasswordConfirmDialog open={deletingAccount} onClose={() => { if (!removeAccount.isPending) setDeletingAccount(false); }} title="Delete your account?"
        description={ACCOUNT_CONSEQUENCE} actionLabel="Delete account" destructive pending={removeAccount.isPending} onConfirm={password => removeAccount.mutate(password)} />
    </>
  );
}
