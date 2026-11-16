import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useBinActions } from '@/hooks/use-bin-actions';
import { addressBooksApi, invalidateBookQueries } from '@/lib/address-books-api';
import { ContactVersionConflict, type ContactInput } from '@/lib/contacts-api';

/**
 * Changes to one shared book's contacts, with their feedback, in the shape
 * the contact editor takes from useContactActions. A deleted contact goes to
 * the book's own bin; the notice offers Undo.
 */
export function useBookContactActions(bookId: string) {
  const client = useQueryClient();
  const { toast } = useToast();
  const bin = useBinActions('contacts', { book: bookId });
  const refresh = () => { void invalidateBookQueries(client); };
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });
  // A stale version is answered by the editor (reload or overwrite), not by a notice.
  const unlessConflict = (title: string) => (error: Error) => { if (!(error instanceof ContactVersionConflict)) failed(title)(error); };

  const create = useSessionMutation({
    mutationFn: (contact: ContactInput) => addressBooksApi.createContact(bookId, contact),
    onSuccess: () => { refresh(); toast({ title: 'Contact added' }); },
    onError: unlessConflict('Could not add the contact'),
  });
  const update = useSessionMutation({
    mutationFn: ({ id, contact }: { id: string; contact: ContactInput }) => addressBooksApi.updateContact(bookId, id, contact),
    onSuccess: () => { refresh(); toast({ title: 'Contact saved' }); },
    onError: unlessConflict('Could not save the contact'),
  });
  const remove = useSessionMutation({
    mutationFn: (id: string) => addressBooksApi.removeContact(bookId, id),
    onSuccess: binItemIds => { refresh(); bin.movedToBin('1 contact', binItemIds); },
    onError: failed('Could not delete the contact'),
  });
  // The editor shows photo progress and errors in place; these only refresh.
  const setPhoto = useSessionMutation({
    mutationFn: ({ id, file }: { id: string; file: Blob }) => addressBooksApi.setPhoto(bookId, id, file),
    onSuccess: refresh,
  });
  const removePhoto = useSessionMutation({
    mutationFn: (id: string) => addressBooksApi.removePhoto(bookId, id),
    onSuccess: refresh,
  });

  return { create, update, remove, setPhoto, removePhoto };
}
