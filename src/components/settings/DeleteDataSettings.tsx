import { useState } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
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

interface Target {
  id: string;
  module?: ModuleId;
  label: string;
  description: string;
  confirm: string;
  consequence: string;
  path: string;
  method: 'post' | 'delete';
  done: string;
  refresh?: (client: QueryClient) => unknown;
}

const TARGETS: Target[] = [
  { id: 'contacts', module: 'contacts', label: 'Contacts', description: '', confirm: 'Delete all contacts?',
    consequence: 'Every contact is deleted. This cannot be undone.', path: '/settings/clear-contacts', method: 'post', done: 'All contacts deleted',
    refresh: invalidateContactQueries },
  { id: 'calendar', module: 'calendar', label: 'Calendar and ToDo', description: '', confirm: 'Delete all events and tasks?',
    consequence: 'Every calendar event and task is deleted. This cannot be undone.', path: '/settings/clear-calendar', method: 'post', done: 'All events and tasks deleted',
    refresh: invalidateCalendarQueries },
  { id: 'mail', module: 'mail', label: 'Mail accounts', description: 'Mail on your mail servers is not touched.', confirm: 'Delete all mail accounts?',
    consequence: 'Every mail account and its mail in UniHub is deleted. Mail on your mail servers is not touched. This cannot be undone.',
    path: '/settings/clear-mail-accounts', method: 'post', done: 'All mail accounts deleted',
    refresh: client => Promise.all([invalidateMailQueries(client), client.invalidateQueries({ queryKey: senderCandidatesQueryKey })]) },
  { id: 'recordings', module: 'recordings', label: 'Recordings', description: '', confirm: 'Delete all recordings?',
    consequence: 'Every recording and its audio file is deleted. This cannot be undone.', path: '/settings/clear-recordings', method: 'post', done: 'All recordings deleted',
    refresh: client => client.invalidateQueries({ queryKey: recordingsQueryKeys.all }) },
];

const ACCOUNT: Target = {
  id: 'account', label: 'Your account', description: 'Your account and everything in it.', confirm: 'Delete your account?',
  consequence: 'Your account and all of its UniHub data are deleted permanently. This cannot be undone.', path: '/settings/account', method: 'delete', done: '',
};

export default function DeleteDataSettings() {
  const client = useQueryClient();
  const { toast } = useToast();
  const { isEnabled } = useModules();
  const [target, setTarget] = useState<Target | null>(null);

  const remove = useMutation({
    mutationFn: async (entry: Target) => {
      const response = entry.method === 'delete' ? await api.delete<{ message?: string }>(entry.path) : await api.post<{ message?: string }>(entry.path);
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (data, entry) => {
      if (entry.id === 'account') { window.location.assign('/auth'); return; }
      void entry.refresh?.(client);
      toast({ title: data?.message || entry.done });
      setTarget(null);
    },
    onError: (error: Error, entry) => toast({ title: `Could not delete ${entry.id === 'account' ? 'your account' : entry.label.toLowerCase()}`, description: error.message, variant: 'destructive' }),
  });

  return (
    <>
      <SettingsSection title="Delete data" description="Only a backup can bring it back.">
        {TARGETS.filter(entry => !entry.module || isEnabled(entry.module)).map(entry => (
          <SettingsRow key={entry.id} label={entry.label} description={entry.description || undefined}>
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setTarget(entry)}>Delete all</Button>
          </SettingsRow>
        ))}
      </SettingsSection>
      <SettingsSection title="Account">
        <SettingsRow label="Delete your account" tone="destructive">
          <Button variant="destructive" onClick={() => setTarget(ACCOUNT)}>Delete account</Button>
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
              {target?.id === 'account' ? 'Delete account' : 'Delete all'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
