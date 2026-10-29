import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { contactsApi, contactsQueryKeys, ContactVersionConflict, invalidateContactQueries, type BulkContactChange, type ContactInput, type ExportFormat, type MergeRequest } from '@/lib/contacts-api';
import { saveFile } from '@/lib/platform';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Every change to contacts, with its feedback. Saving a contact answers through the editor itself (it shows conflicts inline). */
export function useContactActions() {
  const client = useQueryClient();
  const { toast } = useToast();
  const refresh = () => { void invalidateContactQueries(client); };
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });

  // A stale version is answered by the editor (reload or overwrite), not by a notice.
  const unlessConflict = (title: string) => (error: Error) => { if (!(error instanceof ContactVersionConflict)) failed(title)(error); };

  const create = useMutation({
    mutationFn: (contact: ContactInput) => contactsApi.create(contact),
    onSuccess: () => { refresh(); toast({ title: 'Contact added' }); },
    onError: unlessConflict('Could not add the contact'),
  });

  const update = useMutation({
    mutationFn: ({ id, contact }: { id: string; contact: ContactInput }) => contactsApi.update(id, contact),
    onSuccess: () => { refresh(); toast({ title: 'Contact saved' }); },
    onError: unlessConflict('Could not save the contact'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => contactsApi.remove(id),
    onSuccess: () => { refresh(); toast({ title: 'Contact deleted' }); },
    onError: failed('Could not delete the contact'),
  });

  const removeMany = useMutation({
    mutationFn: (ids: string[]) => contactsApi.removeMany(ids),
    onSuccess: deleted => { refresh(); toast({ title: `${plural(deleted, 'contact')} deleted` }); },
    onError: failed('Could not delete the contacts'),
  });

  const updateMany = useMutation({
    mutationFn: ({ ids, contact }: { ids: string[]; contact: BulkContactChange }) => contactsApi.updateMany(ids, contact),
    onSuccess: updated => { refresh(); toast({ title: `${plural(updated, 'contact')} updated` }); },
    onError: failed('Could not update the contacts'),
  });

  const setFavorite = useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => contactsApi.setFavorite(id, favorite),
    onSuccess: refresh,
    onError: failed('Could not update favorites'),
  });

  // The editor shows photo progress and errors in place; these only refresh.
  const setPhoto = useMutation({
    mutationFn: ({ id, file }: { id: string; file: Blob }) => contactsApi.setPhoto(id, file),
    onSuccess: refresh,
  });
  const removePhoto = useMutation({
    mutationFn: (id: string) => contactsApi.removePhoto(id),
    onSuccess: refresh,
  });

  const undoMerge = useMutation({
    mutationFn: (mergeId: string) => contactsApi.undoMerge(mergeId),
    onSuccess: result => {
      refresh();
      toast(result.survivor_restored
        ? { title: 'Merge undone', description: `${plural(result.restored_ids.length, 'contact')} restored.` }
        : { title: 'Merge undone', description: 'The merged contact was edited since, so its later changes were kept; the restored contacts are back as they were.' });
    },
    onError: failed('Could not undo the merge'),
  });

  const merge = useMutation({
    mutationFn: (request: MergeRequest) => contactsApi.merge(request),
    onSuccess: result => {
      refresh();
      toast({
        title: `Merged into ${result.contact.display_name || 'one contact'}`,
        description: `${plural(result.merged_ids.length, 'other contact')} folded in. Undo is available for 30 days under Recently merged.`,
        action: <ToastAction altText="Undo this merge" onClick={() => undoMerge.mutate(result.merge_id)}>Undo</ToastAction>,
      });
    },
    onError: failed('Could not merge'),
  });

  const mergeAll = useMutation({
    mutationFn: (groupIds: string[]) => contactsApi.mergeAll(groupIds),
    onSuccess: result => {
      refresh();
      const merged = result.results.filter(entry => entry.status === 'merged').length;
      const left = result.results.length - merged;
      toast({
        title: merged ? `${plural(merged, 'group')} merged` : 'Nothing merged',
        description: left ? `${plural(left, 'group')} changed meanwhile or needs your choice; it stays in the list.` : 'Undo each merge under Recently merged for 30 days.',
      });
    },
    onError: failed('Could not merge the groups'),
  });

  const dismissDuplicates = useMutation({
    mutationFn: (contactIds: string[]) => contactsApi.dismissDuplicates(contactIds),
    onSuccess: () => { void client.invalidateQueries({ queryKey: [...contactsQueryKeys.all, 'duplicates'] }); toast({ title: 'Kept apart', description: 'These are not shown as duplicates again.' }); },
    onError: failed('Could not save the choice'),
  });

  const exportContacts = useMutation({
    mutationFn: async ({ ids, format }: { ids: string[] | null; format: ExportFormat }) => {
      const { blob, filename } = ids ? await contactsApi.exportSelected(ids, format) : await contactsApi.exportAll(format);
      await saveFile(blob, filename || (format.endsWith('csv') ? 'contacts.csv' : 'contacts.vcf'));
    },
    onSuccess: () => toast({ title: 'Contacts exported' }),
    onError: failed('Export failed'),
  });

  return { create, update, remove, removeMany, updateMany, setFavorite, setPhoto, removePhoto, merge, mergeAll, undoMerge, dismissDuplicates, exportContacts };
}

export type ContactActions = ReturnType<typeof useContactActions>;
