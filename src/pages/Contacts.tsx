import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Plus, Search, Upload, Users, X } from 'lucide-react';
import { contactsApi, contactsQueryOptions, contactName, type Contact, type MergePreview } from '@/lib/contacts-api';
import { CONTACT_VIEWS, filterContacts, findDuplicates, inContactView, isContactView, type ContactView } from '@/lib/contact-views';
import { preferencesQueryOptions } from '@/lib/settings-api';
import { saveFile } from '@/lib/platform';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useContactActions } from '@/hooks/use-contact-actions';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { NarrowOnly, PageBody, PageHeader, PageShell, PanelGroup, PanelHeader, PanelItem } from '@/components/layout/PageShell';
import { ContactList } from '@/components/contacts/ContactList';
import { ContactDetail } from '@/components/contacts/ContactDetail';
import { ContactDialog, type ContactDialogTarget } from '@/components/contacts/ContactDialog';

const SEARCH_DEBOUNCE_MS = 300;

type Confirm = { title: string; description: string; action: string; run: () => void };

/** The duplicates view's merge step: look first, then merge after a confirmation. */
function MergeDuplicates({ groups, onConfirm }: { groups: number; onConfirm: (confirm: Confirm) => void }) {
  const actions = useContactActions();
  const [preview, setPreview] = useState<MergePreview | null>(null);
  return (
    <div className="mb-5 rounded-lg border border-border px-4 py-3 text-sm">
      <p className="text-muted-foreground">
        {groups === 1 ? '1 group' : `${groups} groups`} of possible duplicates. Merging keeps one contact per group, adds the others' details to it and deletes the rest. Merging is experimental.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={actions.previewMerge.isPending}
          onClick={() => actions.previewMerge.mutate(undefined, { onSuccess: setPreview })}>Preview merge</Button>
        <Button variant="outline" size="sm" disabled={actions.mergeDuplicates.isPending} onClick={() => onConfirm({
          title: 'Merge duplicates?',
          description: 'One contact per group is kept and the others are deleted. This cannot be undone.',
          action: 'Merge', run: () => actions.mergeDuplicates.mutate(undefined, { onSuccess: () => setPreview(null) }),
        })}>Merge duplicates</Button>
      </div>
      {preview && (
        <div className="mt-3 border-t border-border pt-3">
          {preview.groups === 0 ? <p className="text-muted-foreground">The server found no duplicates to merge.</p> : (
            <>
              <p className="mb-2 text-muted-foreground">{preview.groups} groups would be merged and {preview.to_remove} contacts deleted.</p>
              <ul className="space-y-1">
                {preview.preview.slice(0, 8).map(item => (
                  <li key={item.key}>Keep <span className="font-medium">{item.keep.name}</span>
                    <span className="text-muted-foreground">, delete {item.remove.map(entry => entry.name).join(', ') || 'none'}</span></li>
                ))}
              </ul>
              {preview.preview.length > 8 && <p className="mt-2 text-xs text-muted-foreground">Showing 8 of {preview.preview.length} groups.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const Contacts = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const actions = useContactActions();
  const fileInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(() => params.get('search') || params.get('q') || '');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<ContactDialogTarget>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);

  const viewParam = params.get('view');
  const view: ContactView = isContactView(viewParam) ? viewParam : 'all';
  const activeId = params.get('contact');

  const contactsQuery = useQuery(contactsQueryOptions);
  const { data: preferences } = useQuery(preferencesQueryOptions);
  const allContacts = useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);
  const duplicates = useMemo(() => findDuplicates(allContacts), [allContacts]);
  const contacts = useMemo(() => filterContacts(allContacts, view, debouncedSearch, duplicates), [allContacts, view, debouncedSearch, duplicates]);
  const active = activeId ? allContacts.find(contact => contact.id === activeId) ?? null : null;
  const counts = useMemo(() => Object.fromEntries((Object.keys(CONTACT_VIEWS) as ContactView[])
    .map(id => [id, allContacts.filter(contact => inContactView(contact, id, duplicates)).length])) as Record<ContactView, number>, [allContacts, duplicates]);
  const duplicateGroups = useMemo(() => new Set([...duplicates.values()].map(entry => entry.key)).size, [duplicates]);

  const updateParams = (change: (next: URLSearchParams) => void, replace = false) => {
    const next = new URLSearchParams(params);
    change(next);
    setParams(next, { replace });
  };

  // Links from Today, Mail and the command palette: ?action=new&name=&email=, ?search=.
  useEffect(() => {
    if (params.get('action') !== 'new' && !params.has('search') && !params.has('q')) return;
    if (params.get('action') === 'new') setDialog({ kind: 'new', name: params.get('name') ?? undefined, email: params.get('email') ?? undefined });
    const linkedSearch = params.get('search') ?? params.get('q');
    if (linkedSearch !== null) setSearch(linkedSearch);
    updateParams(next => { for (const key of ['action', 'name', 'email', 'search', 'q']) next.delete(key); }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // A selection belongs to the list it was made in.
  useEffect(() => { setSelectedIds(new Set()); }, [view, debouncedSearch]);

  const selectView = (id: ContactView) => updateParams(next => { next.delete('contact'); if (id === 'all') next.delete('view'); else next.set('view', id); });
  const openContact = (contact: Contact | null) => updateParams(next => { if (contact) next.set('contact', contact.id); else next.delete('contact'); });

  const toggleSelect = (contact: Contact) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(contact.id)) next.delete(contact.id); else next.add(contact.id);
    return next;
  });
  const toggleFavorite = (contact: Contact) => actions.setFavorite.mutate({ id: contact.id, favorite: !contact.is_favorite });

  const confirmDelete = (contact: Contact) => setConfirm({
    title: `Delete ${contactName(contact)}?`, description: 'This cannot be undone.', action: 'Delete',
    run: () => actions.remove.mutate(contact.id, { onSuccess: () => { if (activeId === contact.id) openContact(null); } }),
  });
  const confirmDeleteSelected = () => setConfirm({
    title: selectedIds.size === 1 ? 'Delete 1 contact?' : `Delete ${selectedIds.size} contacts?`, description: 'This cannot be undone.', action: 'Delete',
    run: () => actions.removeMany.mutate([...selectedIds], { onSuccess: () => {
      if (activeId && selectedIds.has(activeId)) openContact(null);
      setSelectedIds(new Set());
    } }),
  });

  const emailInUniHub = preferences?.email_link_behavior === 'internal'
    ? (address: string) => navigate(`/mail?${new URLSearchParams({ action: 'compose', to: address, returnTo: `${location.pathname}${location.search}` })}`)
    : undefined;

  const exportAll = async () => {
    try {
      const { blob, filename } = await contactsApi.exportVcf();
      await saveFile(blob, filename || 'contacts.vcf');
      toast({ title: 'Contacts exported' });
    } catch (error) {
      toast({ title: 'Export failed', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    }
  };

  const panel = (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PanelHeader title="Contacts" action={<Button size="sm" onClick={() => setDialog({ kind: 'new' })}><Plus aria-hidden="true" />New</Button>} />
      <PanelGroup>
        {(Object.keys(CONTACT_VIEWS) as ContactView[]).map(id => (id === 'all' || counts[id] > 0 || view === id) && (
          <PanelItem key={id} icon={CONTACT_VIEWS[id].icon} active={view === id} onSelect={() => selectView(id)}
            count={counts[id]} countLabel="contacts" countTone={id === 'duplicates' ? 'warning' : 'default'}>
            {CONTACT_VIEWS[id].label}
          </PanelItem>
        ))}
      </PanelGroup>
      <PanelGroup label="vCard" className="border-t border-border pt-3">
        <PanelItem icon={Upload} onSelect={() => fileInput.current?.click()}>Import contacts</PanelItem>
        <PanelItem icon={Download} onSelect={() => void exportAll()}>Export all contacts</PanelItem>
      </PanelGroup>
    </div>
  );

  const selecting = selectedIds.size > 0;
  const allSelected = selecting && contacts.every(contact => selectedIds.has(contact.id));

  const list = contactsQuery.isLoading ? <LoadingState label="Loading contacts…" />
    : contactsQuery.error ? <ErrorState title="Could not load contacts" error={contactsQuery.error} onRetry={() => void contactsQuery.refetch()} retrying={contactsQuery.isFetching} />
    : (
      <>
        {view === 'duplicates' && duplicateGroups > 0 && !debouncedSearch && <MergeDuplicates groups={duplicateGroups} onConfirm={setConfirm} />}
        {view !== 'all' && view !== 'duplicates' && CONTACT_VIEWS[view].hint && contacts.length > 0 && (
          <p className="mb-4 text-sm text-muted-foreground">{CONTACT_VIEWS[view].hint}</p>
        )}
        {contacts.length === 0 ? (
          <EmptyState icon={Users}
            title={debouncedSearch ? 'No contacts match' : view === 'all' ? 'No contacts yet' : `Nothing in ${CONTACT_VIEWS[view].label}`}
            description={debouncedSearch ? 'Try another name, address or number.' : view === 'all' ? 'Add a contact, or import a vCard file from another app.' : undefined}
            action={view === 'all' && !debouncedSearch ? <Button variant="outline" onClick={() => setDialog({ kind: 'new' })}><Plus aria-hidden="true" />New contact</Button> : undefined} />
        ) : (
          <ContactList contacts={contacts} view={view} duplicates={duplicates} activeId={activeId} selectedIds={selectedIds}
            onOpen={openContact} onToggleSelect={toggleSelect} onToggleFavorite={toggleFavorite} />
        )}
      </>
    );

  return (
    <PageShell panel={panel} panelLabel="Contact lists">
      <PageHeader title="Contacts" scope={CONTACT_VIEWS[view].label} className={active ? 'hidden lg:block' : undefined}
        actions={<NarrowOnly><Button size="icon" aria-label="New contact" onClick={() => setDialog({ kind: 'new' })}><Plus aria-hidden="true" /></Button></NarrowOnly>}>
        <div className="flex h-12 items-center gap-2 px-4 md:px-6">
          {selecting ? (
            <>
              <Button variant="ghost" size="icon" aria-label="Clear selection" onClick={() => setSelectedIds(new Set())}><X aria-hidden="true" /></Button>
              <span className="text-sm font-medium">{selectedIds.size} selected</span>
              {!allSelected && <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set(contacts.map(contact => contact.id)))}>Select all {contacts.length}</Button>}
              <Button variant="outline" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={confirmDeleteSelected}>Delete</Button>
            </>
          ) : (
            <div className="relative w-full max-w-md">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search contacts" aria-label="Search contacts" className="h-9 pl-9" />
            </div>
          )}
        </div>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div className={active ? 'hidden min-h-0 flex-1 flex-col lg:flex' : 'flex min-h-0 flex-1 flex-col'}>
          <PageBody width="reading">{list}</PageBody>
        </div>
        {active && (
          <aside aria-label="Contact" className="min-h-0 flex-1 overflow-y-auto pb-mobile-nav md:pb-0 lg:w-[26rem] lg:flex-none lg:border-l lg:border-border">
            <ContactDetail contact={active} onEmail={emailInUniHub} onBack={() => openContact(null)}
              onEdit={() => setDialog({ kind: 'edit', contact: active })} onDelete={() => confirmDelete(active)} onToggleFavorite={() => toggleFavorite(active)} />
          </aside>
        )}
      </div>

      <input ref={fileInput} type="file" accept=".vcf,text/vcard" className="hidden"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) actions.importVcf.mutate(file, { onSuccess: () => { setSearch(''); selectView('all'); } });
        }} />
      <ContactDialog target={dialog} onClose={() => setDialog(null)} actions={actions} />
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
    </PageShell>
  );
};

export default Contacts;
