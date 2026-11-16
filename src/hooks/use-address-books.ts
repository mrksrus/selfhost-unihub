import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useModules } from '@/hooks/use-modules';
import { addressBooksApi, addressBooksQueryKeys, addressBooksQueryOptions, bookContactsQueryOptions, COMPANY_BOOK } from '@/lib/address-books-api';
import { bookBinQueryOptions } from '@/lib/bin-api';
import { directoryQueryOptions } from '@/lib/directory-api';
import { can } from '@/lib/permissions';

// Shared address books and the company directory for the Contacts page,
// Settings and Server › Shared books. The lists and contacts read offline
// from the snapshot (lib/offline.ts); shares, candidates, bins and the
// administrator's list are live only.

function useContactsOn() {
  const { user, isOffline } = useAuth();
  const { isEnabled } = useModules();
  return { user, online: !!user && !isOffline, on: !!user && isEnabled('contacts') };
}

/** Company, then the books shared with the person or created by them. */
export function useAddressBooks() {
  const { on } = useContactsOn();
  return useQuery({ ...addressBooksQueryOptions, enabled: on });
}

/** One book's contacts (Company's are the directory in contact shape). */
export function useBookContacts(bookId: string | undefined) {
  const { on } = useContactsOn();
  return useQuery({ ...bookContactsQueryOptions(bookId ?? ''), enabled: on && !!bookId });
}

/** One contact of a book with its kept properties. */
export function useBookContact(bookId: string | undefined, contactId: string | undefined) {
  const { on } = useContactsOn();
  return useQuery({
    queryKey: addressBooksQueryKeys.contact(bookId ?? '', contactId ?? ''),
    queryFn: ({ signal }) => addressBooksApi.contact(bookId!, contactId!, signal),
    enabled: on && !!bookId && !!contactId,
  });
}

/** A book's shares, for those who manage it. */
export function useBookShares(bookId: string | undefined, manages: boolean) {
  const { on, online } = useContactsOn();
  return useQuery({
    queryKey: addressBooksQueryKeys.shares(bookId ?? ''),
    queryFn: ({ signal }) => addressBooksApi.shares(bookId!, signal),
    enabled: on && online && !!bookId && bookId !== COMPANY_BOOK && manages,
  });
}

/** People and groups within the manager's reach, searched as they type. */
export function useShareCandidates(bookId: string | undefined, query: string, enabled = true) {
  const { on, online } = useContactsOn();
  const search = useDebouncedValue(query.trim());
  return useQuery({
    queryKey: addressBooksQueryKeys.candidates(bookId ?? '', search),
    queryFn: ({ signal }) => addressBooksApi.candidates(bookId!, search, signal),
    enabled: on && online && !!bookId && bookId !== COMPANY_BOOK && enabled,
  });
}

/** A book's Deleted view, for those who may edit it. */
export function useBookBin(bookId: string | undefined, edits: boolean) {
  const { on, online } = useContactsOn();
  return useInfiniteQuery({ ...bookBinQueryOptions(bookId ?? ''), enabled: on && online && !!bookId && bookId !== COMPANY_BOOK && edits });
}

/** The company directory with each person's groups. */
export function useDirectory() {
  const { on } = useContactsOn();
  return useQuery({ ...directoryQueryOptions, enabled: on });
}

/** Server › Shared books: every book, deleted ones included. */
export function useAdminAddressBooks() {
  const { user, online } = useContactsOn();
  return useQuery({
    queryKey: addressBooksQueryKeys.admin,
    queryFn: ({ signal }) => addressBooksApi.adminList(signal),
    enabled: online && can(user, 'contacts.books.manage'),
  });
}
