import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useBookShares, useShareCandidates } from '@/hooks/use-address-books';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { addressBooksApi, addressBooksQueryKeys, type AddressBook, type SharePermission } from '@/lib/address-books-api';
import { can } from '@/lib/permissions';
import { ShareDialog, type ShareChange } from '@/components/organisation/ShareDialog';

const LEVELS: Record<SharePermission, string> = { read: 'Can read', edit: 'Can edit' };

/** Who a shared book is shared with, each reading or editing; its creator manages it. */
export function BookShareDialog({ book, open, onClose }: { book: Pick<AddressBook, 'id' | 'name'>; open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const [query, setQuery] = useState('');
  const shares = useBookShares(book.id, open);
  const candidates = useShareCandidates(book.id, query, open);
  const change = useSessionMutation({
    mutationFn: ({ principal, permission }: ShareChange<SharePermission>) => addressBooksApi.setShare(book.id, { principal, permission }),
    onSuccess: (next, { name, permission }) => {
      client.setQueryData(addressBooksQueryKeys.shares(book.id), next);
      toast({ title: permission ? `${name} ${permission === 'edit' ? 'can edit' : 'can read'} ${book.name}` : `No longer shared with ${name}` });
    },
    onError: (error: Error) => toast({ title: 'Could not change the share', description: error.message, variant: 'destructive' }),
  });
  return (
    <ShareDialog open={open} onClose={onClose} title={<>Share {book.name}</>} description="They find it under Contacts, in Shared. A change applies as soon as you make it."
      noun="book" levels={LEVELS} fixed="Manages it" shares={shares} query={query} onQuery={setQuery} candidates={candidates}
      notes={[!can(user, 'contacts.books.manage') && 'You can share with the groups you are in and the people in them. An administrator can share with anyone.']}
      pending={change.isPending} onChange={change.mutate} />
  );
}
