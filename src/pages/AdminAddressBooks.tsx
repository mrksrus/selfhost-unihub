import { useQueryClient } from '@tanstack/react-query';
import { BookUser } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useAdminAddressBooks } from '@/hooks/use-address-books';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { addressBooksApi, invalidateBookQueries, type AdminAddressBook } from '@/lib/address-books-api';
import { can } from '@/lib/permissions';
import { formatDay } from '@/components/admin/person-words';
import { GroupRow } from '@/components/organisation/GroupRow';
import { SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';

// Server › Shared books: every shared address book of the organisation, also
// those not shared with the administrator, who manages each of them from its
// page in Contacts. A deleted book waits here until it is purged; Restore
// brings it back with its contacts and shares.

const meta = (book: AdminAddressBook) => [
  `${book.contact_count} ${book.contact_count === 1 ? 'contact' : 'contacts'}`,
  book.created_by ? `by ${book.created_by.full_name || book.created_by.email}` : 'its creator has left',
].join(', ');

const AdminAddressBooks = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const books = useAdminAddressBooks();
  const restore = useSessionMutation({
    mutationFn: addressBooksApi.adminRestore,
    onSuccess: book => { void invalidateBookQueries(client); toast({ title: `${book.name} restored`, description: 'It is back for everyone it was shared with.' }); },
    onError: (error: Error) => toast({ title: 'Could not restore the book', description: error.message, variant: 'destructive' }),
  });
  const live = books.data?.filter(book => !book.deleted_at) ?? [];
  const deleted = books.data?.filter(book => book.deleted_at) ?? [];

  return (
    <PageShell panel={<SettingsPanel active="admin-address-books" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope="Shared books" />
      <PageBody width="reading">
        {!can(user, 'contacts.books.manage') ? <p className="text-sm text-muted-foreground">Only administrators can see this page.</p> : (
          <>
            <div className="mb-4">
              <h2 className="text-base font-semibold">Shared books</h2>
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">Every shared address book on this server, also those not shared with you. A book belongs to the organisation: it stays when its creator leaves, and you manage each of them from its page.</p>
            </div>
            {books.isLoading ? <LoadingState label="Loading the books…" />
              : books.error ? <ErrorState title="Could not load the books" error={books.error} onRetry={() => void books.refetch()} retrying={books.isFetching} />
              : (
                <>
                  {live.length === 0 ? <EmptyState icon={BookUser} title="No shared books yet" description="Anyone can make one in Contacts, under Shared, and share it with people or groups." />
                    : (
                      <ul aria-label="Shared books" className="mb-10 divide-y divide-border border-y border-border">
                        {live.map(book => <GroupRow key={book.id} to={`/contacts?book=${encodeURIComponent(book.id)}`} name={book.name} description={book.description} meta={meta(book)} />)}
                      </ul>
                    )}
                  {deleted.length > 0 && (
                    <SettingsSection title="Deleted" description="Hidden for everyone. A deleted book is kept as long as a shared book's bin keeps its contacts, at least 30 days, and then deleted for good with them. Restore brings it back with its contacts and shares.">
                      {deleted.map(book => (
                        <SettingsRow key={book.id} label={book.name} description={`${meta(book)}, deleted ${formatDay(book.deleted_at!)}`}>
                          <Button variant="outline" size="sm" disabled={restore.isPending} aria-label={`Restore ${book.name}`} onClick={() => restore.mutate(book.id)}>Restore</Button>
                        </SettingsRow>
                      ))}
                    </SettingsSection>
                  )}
                </>
              )}
          </>
        )}
      </PageBody>
    </PageShell>
  );
};

export default AdminAddressBooks;
