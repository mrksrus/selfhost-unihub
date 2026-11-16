import { useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BookUser, Building2, MoreHorizontal, Plus, UserPlus } from 'lucide-react';
import { useBookBin, useBookContacts } from '@/hooks/use-address-books';
import { useBookContactActions } from '@/hooks/use-book-contact-actions';
import { usePolicy } from '@/hooks/use-policies';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useUserSettings } from '@/hooks/use-settings';
import { useToast } from '@/hooks/use-toast';
import { addressBooksApi, COMPANY_BOOK, invalidateBookQueries, type AddressBook } from '@/lib/address-books-api';
import { filterContacts } from '@/lib/contact-views';
import { contactName, type Contact } from '@/lib/contacts-api';
import { directoryQueryOptions } from '@/lib/directory-api';
import { BinView } from '@/components/bin/BinView';
import { BOOK_WORDS } from '@/components/contacts/book-words';
import { BookShareDialog } from '@/components/contacts/BookShareDialog';
import { ContactDetail } from '@/components/contacts/ContactDetail';
import { ContactEditor, type ContactEditorTarget } from '@/components/contacts/ContactEditor';
import { ContactImportDialog } from '@/components/contacts/ContactImportDialog';
import { ContactList } from '@/components/contacts/ContactList';
import { PageBody } from '@/components/layout/PageShell';
import { GroupDialog } from '@/components/organisation/GroupDialog';
import { settingsHref } from '@/components/settings/settings-sections';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Chip, ChipGroup } from '@/components/ui/chips';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { PolicyNote } from '@/components/ui/policy-note';
import { Switch } from '@/components/ui/switch';

// One shared address book, or the company directory, inside the Contacts
// page: its contacts as the person's own are shown, what the person may do
// with it by the permission the server reported (it checks every change
// again), the book's own bin for those who may edit, and the person's
// choice of whether it goes to their phones.

const READ_ONLY = 'You can read this book. Whoever manages it, or an administrator, decides who may change it.';
const COMPANY_ENTRY = 'From the company directory. Each person changes their own entry under Settings › Profile.';
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

type Confirm = { title: string; description: string; action: string; run: () => void };

export function BookView({ book, search, onEmail }: { book: AddressBook; search: string; onEmail?: (address: string) => void }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { toast } = useToast();
  const phoneId = useId();
  const company = book.id === COMPANY_BOOK;
  const edits = !company && book.permission !== 'read';
  const manages = !company && book.permission === 'manage';
  const view = edits && params.get('view') === 'bin' ? 'bin' : 'contacts';
  const activeId = params.get('contact');
  const [editor, setEditor] = useState<ContactEditorTarget>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [dialog, setDialog] = useState<'share' | 'rename' | 'import' | null>(null);

  const actions = useBookContactActions(book.id);
  const contactsQuery = useBookContacts(book.id);
  const binQuery = useBookBin(book.id, edits);
  const directory = useQuery({ ...directoryQueryOptions, enabled: company });
  const phoneRule = usePolicy('contacts.phone_sync');
  const settings = useUserSettings();
  const phonesOff = settings.values.contacts_phone_books_off;

  const all = useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);
  const contacts = useMemo(() => filterContacts(all, 'all', search), [all, search]);
  const active = activeId ? all.find(contact => contact.id === activeId) ?? null : null;

  const update = (change: (next: URLSearchParams) => void) => { const next = new URLSearchParams(params); change(next); setParams(next); };
  const openContact = (contact: Contact | null) => update(next => { if (contact) next.set('contact', contact.id); else next.delete('contact'); });
  const showView = (id: 'contacts' | 'bin') => update(next => { next.delete('contact'); if (id === 'bin') next.set('view', 'bin'); else next.delete('view'); });

  const rename = useSessionMutation({
    mutationFn: (input: { name: string; description: string | null }) => addressBooksApi.rename(book.id, input),
    onSuccess: () => { void invalidateBookQueries(client); setDialog(null); toast({ title: 'Book saved' }); },
    onError: (error: Error) => toast({ title: 'Could not save the book', description: error.message, variant: 'destructive' }),
  });
  const removeBook = useSessionMutation({
    mutationFn: () => addressBooksApi.remove(book.id),
    onSuccess: () => {
      void invalidateBookQueries(client);
      toast({ title: `${book.name} deleted`, description: 'An administrator can restore it under Server › Shared books.' });
      navigate('/contacts', { replace: true });
    },
    onError: (error: Error) => toast({ title: 'Could not delete the book', description: error.message, variant: 'destructive' }),
  });

  const confirmDelete = (contact: Contact) => setConfirm({
    title: `Delete ${contactName(contact)} from ${book.name}?`, description: 'It goes to this book\'s bin, where everyone who can edit the book can restore it.', action: 'Delete',
    run: () => actions.remove.mutate(contact.id, { onSuccess: () => { if (activeId === contact.id) openContact(null); } }),
  });
  const confirmDeleteBook = () => setConfirm({
    title: `Delete ${book.name}?`, action: 'Delete book',
    description: `The book and its ${plural(book.contact_count, 'contact', 'contacts')} disappear for everyone it is shared with, and from their phones at the next sync. An administrator can restore it under Server › Shared books for at least 30 days.`,
    run: () => removeBook.mutate(),
  });

  const binCount = binQuery.data?.pages[0]?.items.length ?? 0;
  const empty = search ? { title: 'No contacts match', description: 'Try another name, address or number.' }
    : company ? { title: 'Nobody is listed yet', description: undefined }
    : { title: 'This book is empty', description: edits ? 'Add a contact, import a vCard or CSV file, or copy some of your own: select them under All contacts.' : undefined };
  const list = view === 'bin' ? <BinView module="contacts" book={book} />
    : contactsQuery.isLoading ? <LoadingState label="Loading contacts…" />
    : contactsQuery.error ? <ErrorState title="Could not load this book" error={contactsQuery.error} onRetry={() => void contactsQuery.refetch()} retrying={contactsQuery.isFetching} />
    : contacts.length === 0 ? (
      <EmptyState icon={company ? Building2 : BookUser} title={empty.title} description={empty.description}
        action={edits && !search ? <Button variant="outline" onClick={() => setEditor({ kind: 'new' })}><Plus aria-hidden="true" />New contact</Button> : undefined} />
    ) : <ContactList contacts={contacts} activeId={activeId} bookId={book.id} onOpen={contact => openContact(contact)} />;

  return (
    <div className="flex min-h-0 flex-1">
      <div className={active ? 'hidden min-h-0 flex-1 flex-col lg:flex' : 'flex min-h-0 flex-1 flex-col'}>
        <PageBody width="reading">
          <div className="mb-5">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div className="min-w-0">
                <h2 className="break-words text-base font-semibold">{book.name}</h2>
                {company ? (
                  <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                    Everyone with an account on this server. Each person fills in their own phone, job title and department under{' '}
                    <Link to={settingsHref('account')} className="underline underline-offset-2 hover:text-foreground">Settings › Profile</Link>.
                  </p>
                ) : book.description && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{book.description}</p>}
                <p className="mt-1 text-sm text-muted-foreground">
                  {company ? plural(book.contact_count, 'person', 'people') : `${plural(book.contact_count, 'contact', 'contacts')}${manages ? '. You manage this book.' : edits ? '. You can edit it.' : ''}`}
                </p>
                {!company && !edits && <PolicyNote reason={READ_ONLY} />}
              </div>
              {edits && (
                <div className="flex shrink-0 items-center gap-2">
                  {manages && <Button variant="outline" onClick={() => setDialog('share')}><UserPlus aria-hidden="true" />Share</Button>}
                  <Button onClick={() => setEditor({ kind: 'new' })}><Plus aria-hidden="true" />New contact</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`More actions for ${book.name}`}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setDialog('import')}>Import from a file…</DropdownMenuItem>
                      {manages && <DropdownMenuItem onClick={() => setDialog('rename')}>Rename</DropdownMenuItem>}
                      {manages && <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={confirmDeleteBook}>Delete book</DropdownMenuItem>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-y border-border py-3">
              {edits && (
                <ChipGroup label="View">
                  <Chip selected={view === 'contacts'} onSelect={() => showView('contacts')}>Contacts</Chip>
                  <Chip selected={view === 'bin'} onSelect={() => showView('bin')} count={binCount} countLabel="deleted">Deleted</Chip>
                </ChipGroup>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <Switch id={phoneId} checked={!phoneRule.lock && !phonesOff.includes(book.id)} disabled={!!phoneRule.lock || settings.unavailable}
                    onCheckedChange={on => settings.change({ contacts_phone_books_off: on ? phonesOff.filter(id => id !== book.id) : [...phonesOff, book.id] })} />
                  <label htmlFor={phoneId} className="text-sm">
                    On my phones <span className="text-muted-foreground">(read-only, with the Android app)</span>
                  </label>
                </div>
                {phoneRule.lock && <PolicyNote reason={phoneRule.lock} />}
              </div>
            </div>
          </div>
          {list}
        </PageBody>
      </div>
      {active && (
        <aside aria-label="Contact" className="min-h-0 flex-1 overflow-y-auto pb-mobile-nav md:pb-0 lg:w-[26rem] lg:flex-none lg:border-l lg:border-border">
          <ContactDetail contact={active} book={book} onEmail={onEmail} onBack={() => openContact(null)}
            readOnly={company ? COMPANY_ENTRY : edits ? undefined : READ_ONLY} groups={company ? directory.data?.find(entry => entry.user_id === active.id)?.groups : undefined}
            onEdit={edits ? () => setEditor({ kind: 'edit', contact: active }) : undefined} onDelete={edits ? () => confirmDelete(active) : undefined} />
        </aside>
      )}

      {edits && <ContactEditor target={editor} onClose={() => setEditor(null)} actions={actions} book={book} />}
      {edits && <ContactImportDialog open={dialog === 'import'} onClose={() => setDialog(null)} book={book} />}
      {manages && <BookShareDialog book={book} open={dialog === 'share'} onClose={() => setDialog(null)} />}
      {manages && <GroupDialog open={dialog === 'rename'} group={book} pending={rename.isPending} words={BOOK_WORDS} onClose={() => setDialog(null)} onSubmit={input => rename.mutate(input)} />}
      <AlertDialog open={!!confirm} onOpenChange={open => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => confirm?.run()}>{confirm?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
