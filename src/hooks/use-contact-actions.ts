import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { contactsApi, invalidateContactQueries, type ContactInput } from '@/lib/contacts-api';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Every change to contacts, with its feedback. */
export function useContactActions() {
  const client = useQueryClient();
  const { toast } = useToast();
  const refresh = () => { void invalidateContactQueries(client); };
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });

  const create = useMutation({
    mutationFn: (contact: ContactInput) => contactsApi.create(contact),
    onSuccess: () => { refresh(); toast({ title: 'Contact added' }); },
    onError: failed('Could not add the contact'),
  });

  const update = useMutation({
    mutationFn: ({ id, contact }: { id: string; contact: Partial<ContactInput> }) => contactsApi.update(id, contact),
    onSuccess: () => { refresh(); toast({ title: 'Contact saved' }); },
    onError: failed('Could not save the contact'),
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

  const setFavorite = useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => contactsApi.setFavorite(id, favorite),
    onSuccess: refresh,
    onError: failed('Could not update favorites'),
  });

  const importVcf = useMutation({
    mutationFn: async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.vcf')) throw new Error('Choose a vCard file (.vcf).');
      return contactsApi.importVcf(await file.text());
    },
    onSuccess: result => {
      refresh();
      if (result.errors?.length) {
        toast({ title: `Imported ${result.imported} of ${result.total} contacts`, description: `${plural(result.errors.length, 'contact')} could not be read.`, variant: 'destructive' });
      } else {
        toast({ title: result.message || `Imported ${plural(result.imported, 'contact')}` });
      }
    },
    onError: failed('Import failed'),
  });

  const previewMerge = useMutation({
    mutationFn: () => contactsApi.previewMerge(),
    onError: failed('Could not check for duplicates'),
  });

  const mergeDuplicates = useMutation({
    mutationFn: () => contactsApi.mergeDuplicates(),
    onSuccess: result => { refresh(); toast({ title: 'Duplicates merged', description: result?.message }); },
    onError: failed('Could not merge duplicates'),
  });

  return { create, update, remove, removeMany, setFavorite, importVcf, previewMerge, mergeDuplicates };
}

export type ContactActions = ReturnType<typeof useContactActions>;
