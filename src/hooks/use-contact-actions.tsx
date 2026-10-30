import { useQueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useSessionScope } from '@/lib/session-scope';
import { contactsApi, contactsQueryKeys, ContactVersionConflict, invalidateContactQueries, MergeRefused, type AutoMergeResult, type BulkContactChange, type ContactInput, type ExportFormat, type MergeRequest } from '@/lib/contacts-api';
import { saveFile } from '@/lib/platform';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Every change to contacts, with its feedback. Saving a contact answers through the editor itself (it shows conflicts inline).
 * An answer that arrives after the session ended (an account switch, a sign-out) shows, caches and saves nothing.
 */
export function useContactActions() {
  const client = useQueryClient();
  const scope = useSessionScope();
  const { toast } = useToast();
  const refresh = () => { void invalidateContactQueries(client); };
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });

  // A stale version is answered by the editor (reload or overwrite), not by a notice.
  const unlessConflict = (title: string) => (error: Error) => { if (!(error instanceof ContactVersionConflict)) failed(title)(error); };

  const create = useSessionMutation({
    mutationFn: (contact: ContactInput) => contactsApi.create(contact),
    onSuccess: () => { refresh(); toast({ title: 'Contact added' }); },
    onError: unlessConflict('Could not add the contact'),
  });

  const update = useSessionMutation({
    mutationFn: ({ id, contact }: { id: string; contact: ContactInput }) => contactsApi.update(id, contact),
    onSuccess: () => { refresh(); toast({ title: 'Contact saved' }); },
    onError: unlessConflict('Could not save the contact'),
  });

  const remove = useSessionMutation({
    mutationFn: (id: string) => contactsApi.remove(id),
    onSuccess: () => { refresh(); toast({ title: 'Contact deleted' }); },
    onError: failed('Could not delete the contact'),
  });

  const removeMany = useSessionMutation({
    mutationFn: (ids: string[]) => contactsApi.removeMany(ids),
    onSuccess: deleted => { refresh(); toast({ title: `${plural(deleted, 'contact')} deleted` }); },
    onError: failed('Could not delete the contacts'),
  });

  const updateMany = useSessionMutation({
    mutationFn: ({ ids, contact }: { ids: string[]; contact: BulkContactChange }) => contactsApi.updateMany(ids, contact),
    onSuccess: updated => { refresh(); toast({ title: `${plural(updated, 'contact')} updated` }); },
    onError: failed('Could not update the contacts'),
  });

  const setFavorite = useSessionMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => contactsApi.setFavorite(id, favorite),
    onSuccess: refresh,
    onError: failed('Could not update favorites'),
  });

  // The editor shows photo progress and errors in place; these only refresh.
  const setPhoto = useSessionMutation({
    mutationFn: ({ id, file }: { id: string; file: Blob }) => contactsApi.setPhoto(id, file),
    onSuccess: refresh,
  });
  const removePhoto = useSessionMutation({
    mutationFn: (id: string) => contactsApi.removePhoto(id),
    onSuccess: refresh,
  });

  const undoMerge = useSessionMutation({
    mutationFn: (mergeId: string) => contactsApi.undoMerge(mergeId),
    onSuccess: result => {
      refresh();
      // The server says what happened to the merged contact (back as it was, or kept with its later changes).
      toast({ title: 'Merge undone', description: result.message || `${plural(result.restored_ids.length, 'contact')} restored.` });
    },
    onError: failed('Could not undo the merge'),
  });

  const merge = useSessionMutation({
    mutationFn: (request: MergeRequest) => contactsApi.merge(request),
    onSuccess: result => {
      refresh();
      toast({
        title: `Merged into ${result.contact.display_name || 'one contact'}`,
        description: `${plural(result.merged_ids.length, 'other contact')} folded in. Undo is available for 30 days under Recently merged.`,
        action: <ToastAction altText="Undo this merge" onClick={() => undoMerge.mutate(result.merge_id)}>Undo</ToastAction>,
      });
    },
    // A refusal to act on (changed contacts, a missing choice, too many values) is shown in the review itself.
    onError: (error: Error) => { if (!(error instanceof MergeRefused)) failed('Could not merge')(error); },
  });

  const mergeAll = useSessionMutation({
    mutationFn: (groupIds: string[]) => contactsApi.mergeAll(groupIds),
    onSuccess: result => {
      refresh();
      const count = (status: AutoMergeResult['results'][number]['status']) => result.results.filter(entry => entry.status === status).length;
      const merged = count('merged');
      const left = [
        count('changed') && `${plural(count('changed'), 'group')} changed meanwhile`,
        count('needs_choice') && `${plural(count('needs_choice'), 'group')} need${count('needs_choice') === 1 ? 's' : ''} your choice`,
        count('too_many_values') && `${plural(count('too_many_values'), 'group')} would hold more values than one contact can`,
      ].filter(Boolean);
      toast({
        title: merged ? `${plural(merged, 'group')} merged` : 'Nothing merged',
        description: left.length ? `${left.join('; ')}. ${left.length === 1 && result.results.length - merged === 1 ? 'It stays' : 'They stay'} in the list to review.`
          : 'Undo each merge under Recently merged for 30 days.',
      });
    },
    onError: failed('Could not merge the groups'),
  });

  const dismissDuplicates = useSessionMutation({
    mutationFn: (contactIds: string[]) => contactsApi.dismissDuplicates(contactIds),
    onSuccess: () => { void client.invalidateQueries({ queryKey: [...contactsQueryKeys.all, 'duplicates'] }); toast({ title: 'Kept apart', description: 'These are not shown as duplicates again.' }); },
    onError: failed('Could not save the choice'),
  });

  const exportContacts = useSessionMutation({
    mutationFn: async ({ ids, format }: { ids: string[] | null; format: ExportFormat }) => {
      const { blob, filename } = ids ? await contactsApi.exportSelected(ids, format) : await contactsApi.exportAll(format);
      // The previous account's file is never handed to the device in the next session.
      if (scope.ended) return;
      await saveFile(blob, filename || (format.endsWith('csv') ? 'contacts.csv' : 'contacts.vcf'));
    },
    onSuccess: () => toast({ title: 'Contacts exported' }),
    onError: failed('Export failed'),
  });

  return { create, update, remove, removeMany, updateMany, setFavorite, setPhoto, removePhoto, merge, mergeAll, undoMerge, dismissDuplicates, exportContacts };
}

export type ContactActions = ReturnType<typeof useContactActions>;
