import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Plus, Search, Upload, Users, X } from 'lucide-react';
import { contactsQueryOptions, contactName, duplicatesQueryOptions, mergesQueryOptions, type Contact, type DuplicateGroup } from '@/lib/contacts-api';
import { CONTACT_VIEWS, filterContacts, inContactView, isContactView, LIST_VIEWS, type ContactView } from '@/lib/contact-views';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useContactActions } from '@/hooks/use-contact-actions';
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
import { ContactEditor, type ContactEditorTarget } from '@/components/contacts/ContactEditor';
import { BulkEditDialog } from '@/components/contacts/BulkEditDialog';
import { DuplicatesView } from '@/components/contacts/DuplicatesView';
import { MergeReviewDialog } from '@/components/contacts/MergeReviewDialog';
import { RecentlyMergedView } from '@/components/contacts/RecentlyMergedView';
import { ContactImportDialog } from '@/components/contacts/ContactImportDialog';
import { ContactExportDialog } from '@/components/contacts/ContactExportDialog';

const SEARCH_DEBOUNCE_MS = 300;

type Confirm = { title: string; description: string; action: string; destructive?: boolean; run: () => void };

const Contacts = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const actions = useContactActions();
  const [search, setSearch] = useState(() => params.get('search') || params.get('q') || '');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchorId = useRef<string | null>(null);
  const [bulkTargets, setBulkTargets] = useState<Contact[] | null>(null);
  const [editor, setEditor] = useState<ContactEditorTarget>(null);
  const [review, setReview] = useState<DuplicateGroup | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);

  const viewParam = params.get('view');
  const view: ContactView = isContactView(viewParam) ? viewParam : 'all';
  const activeId = params.get('contact');

  const contactsQuery = useQuery(contactsQueryOptions);
  // The panel counts for the two server-side views; their bodies read the same queries.
  const duplicatesQuery = useQuery({ ...duplicatesQueryOptions('low'), enabled: !!contactsQuery.data });
  const mergesQuery = useQuery({ ...mergesQueryOptions, enabled: !!contactsQuery.data });
  const { data: emailLinkBehavior } = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('email_link_behavior') });
  const allContacts = useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);
  const contacts = useMemo(() => filterContacts(allContacts, LIST_VIEWS.includes(view) ? view : 'all', debouncedSearch), [allContacts, view, debouncedSearch]);
  const active = activeId ? allContacts.find(contact => contact.id === activeId) ?? null : null;
  const counts = useMemo(() => ({
    ...Object.fromEntries(LIST_VIEWS.map(id => [id, allContacts.filter(contact => inContactView(contact, id)).length])),
    duplicates: duplicatesQuery.data?.groups.length ?? 0,
    merged: mergesQuery.data?.filter(merge => !merge.undone_at).length ?? 0,
  }) as Record<ContactView, number>, [allContacts, duplicatesQuery.data, mergesQuery.data]);

  const updateParams = (change: (next: URLSearchParams) => void, replace = false) => {
    const next = new URLSearchParams(params);
    change(next);
    setParams(next, { replace });
  };

  // Links from Today, Mail and the command palette: ?action=new&name=&email=, ?search=.
  useEffect(() => {
    if (params.get('action') !== 'new' && !params.has('search') && !params.has('q')) return;
    if (params.get('action') === 'new') setEditor({ kind: 'new', name: params.get('name') ?? undefined, email: params.get('email') ?? undefined });
    const linkedSearch = params.get('search') ?? params.get('q');
    if (linkedSearch !== null) setSearch(linkedSearch);
    updateParams(next => { for (const key of ['action', 'name', 'email', 'search', 'q']) next.delete(key); }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // A selection belongs to the list it was made in.
  useEffect(() => { setSelectedIds(new Set()); }, [view, debouncedSearch]);

  const selectView = (id: ContactView) => updateParams(next => { next.delete('contact'); if (id === 'all') next.delete('view'); else next.set('view', id); });
  const openContact = (contact: Contact | null) => updateParams(next => { if (contact) next.set('contact', contact.id); else next.delete('contact'); });

  const toggleSelect = (contact: Contact) => {
    anchorId.current = contact.id;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(contact.id)) next.delete(contact.id); else next.add(contact.id);
      return next;
    });
  };
  const clickContact = (contact: Contact, event: MouseEvent) => {
    if (event.ctrlKey || event.metaKey) return toggleSelect(contact);
    const from = contacts.findIndex(entry => entry.id === anchorId.current);
    if (event.shiftKey && from >= 0) {
      const to = contacts.indexOf(contact);
      setSelectedIds(prev => new Set([...prev, ...contacts.slice(Math.min(from, to), Math.max(from, to) + 1).map(entry => entry.id)]));
      return;
    }
    // A plain click replaces the selection with the opened contact (as Finder does); the open detail stands for that one item, so no toolbar.
    anchorId.current = contact.id;
    setSelectedIds(new Set());
    openContact(contact);
  };
  const toggleFavorite = (contact: Contact) => actions.setFavorite.mutate({ id: contact.id, favorite: !contact.is_favorite });

  const confirmDelete = (contact: Contact) => setConfirm({
    title: `Delete ${contactName(contact)}?`, description: 'This cannot be undone.', action: 'Delete', destructive: true,
    run: () => actions.remove.mutate(contact.id, { onSuccess: () => { if (activeId === contact.id) openContact(null); } }),
  });
  const confirmDeleteSelected = () => setConfirm({
    title: selectedIds.size === 1 ? 'Delete 1 contact?' : `Delete ${selectedIds.size} contacts?`, description: 'This cannot be undone.', action: 'Delete', destructive: true,
    run: () => actions.removeMany.mutate([...selectedIds], { onSuccess: () => {
      if (activeId && selectedIds.has(activeId)) openContact(null);
      setSelectedIds(new Set());
    } }),
  });
  const confirmMergeAll = (groups: DuplicateGroup[]) => setConfirm({
    title: `Merge ${groups.length} group${groups.length === 1 ? '' : 's'}?`,
    description: `${groups.reduce((sum, group) => sum + group.members.length, 0)} contacts become ${groups.length}. Every number, email and other value is kept; only groups where nothing has to be chosen are merged. Each merge can be undone for 30 days under Recently merged.`,
    action: 'Merge', run: () => actions.mergeAll.mutate(groups.map(group => group.id)),
  });
  const editSelected = () => setBulkTargets(allContacts.filter(contact => selectedIds.has(contact.id)));

  // With a selection: Escape clears it, Delete asks to delete it. Not while typing or while any dialog is open.
  const selecting = selectedIds.size > 0;
  useEffect(() => {
    if (!selecting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (event.key === 'Escape') setSelectedIds(new Set());
      else if (event.key === 'Delete') { event.preventDefault(); confirmDeleteSelected(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const emailInUniHub = emailLinkBehavior === 'internal'
    ? (address: string) => navigate(`/mail?${new URLSearchParams({ action: 'compose', to: address, returnTo: `${location.pathname}${location.search}` })}`)
    : undefined;

  const panel = (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PanelHeader title="Contacts" action={<Button size="sm" onClick={() => setEditor({ kind: 'new' })}><Plus aria-hidden="true" />New</Button>} />
      <PanelGroup>
        {(Object.keys(CONTACT_VIEWS) as ContactView[]).map(id => (id === 'all' || counts[id] > 0 || view === id) && (
          <PanelItem key={id} icon={CONTACT_VIEWS[id].icon} active={view === id} onSelect={() => selectView(id)}
            count={counts[id]} countLabel={id === 'duplicates' ? 'groups' : id === 'merged' ? 'merges' : 'contacts'} countTone={id === 'duplicates' ? 'warning' : 'default'}>
            {CONTACT_VIEWS[id].label}
          </PanelItem>
        ))}
      </PanelGroup>
      <PanelGroup label="Files" className="border-t border-border pt-3">
        <PanelItem icon={Upload} onSelect={() => setImporting(true)}>Import contacts</PanelItem>
        <PanelItem icon={Download} onSelect={() => setExporting([])}>Export all contacts</PanelItem>
      </PanelGroup>
    </div>
  );

  const allSelected = selecting && contacts.every(contact => selectedIds.has(contact.id));

  const list = contactsQuery.isLoading ? <LoadingState label="Loading contacts…" />
    : contactsQuery.error ? <ErrorState title="Could not load contacts" error={contactsQuery.error} onRetry={() => void contactsQuery.refetch()} retrying={contactsQuery.isFetching} />
    : view === 'duplicates' ? (
      <DuplicatesView contacts={allContacts} activeId={activeId} selectedIds={selectedIds} actions={actions}
        onOpen={clickContact} onToggleSelect={toggleSelect} onToggleFavorite={toggleFavorite} onReview={setReview} onMergeAll={confirmMergeAll} />
    ) : view === 'merged' ? <RecentlyMergedView actions={actions} />
    : (
      <>
        {view !== 'all' && CONTACT_VIEWS[view].hint && contacts.length > 0 && (
          <p className="mb-4 text-sm text-muted-foreground">{CONTACT_VIEWS[view].hint}</p>
        )}
        {contacts.length === 0 ? (
          <EmptyState icon={Users}
            title={debouncedSearch ? 'No contacts match' : view === 'all' ? 'No contacts yet' : `Nothing in ${CONTACT_VIEWS[view].label}`}
            description={debouncedSearch ? 'Try another name, address or number.' : view === 'all' ? 'Add a contact, or import a vCard or CSV file from another app.' : undefined}
            action={view === 'all' && !debouncedSearch ? <Button variant="outline" onClick={() => setEditor({ kind: 'new' })}><Plus aria-hidden="true" />New contact</Button> : undefined} />
        ) : (
          <ContactList contacts={contacts} activeId={activeId} selectedIds={selectedIds}
            onOpen={clickContact} onToggleSelect={toggleSelect} onToggleFavorite={toggleFavorite} />
        )}
      </>
    );

  return (
    <PageShell panel={panel} panelLabel="Contact lists" panelId="contacts">
      <PageHeader title="Contacts" scope={CONTACT_VIEWS[view].label} className={active ? 'hidden lg:block' : undefined}
        actions={<NarrowOnly><Button size="icon" aria-label="New contact" onClick={() => setEditor({ kind: 'new' })}><Plus aria-hidden="true" /></Button></NarrowOnly>}>
        <div className="flex h-12 items-center gap-2 px-4 md:px-6">
          {selecting ? (
            <>
              <Button variant="ghost" size="icon" aria-label="Clear selection" onClick={() => setSelectedIds(new Set())}><X aria-hidden="true" /></Button>
              <span className="text-sm font-medium">{selectedIds.size} selected</span>
              {!allSelected && view !== 'duplicates' && <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set(contacts.map(contact => contact.id)))}>Select all {contacts.length}</Button>}
              {/* Bulk editing is a desk job; on phones the toolbar keeps its old width. */}
              <Button variant="outline" size="sm" className="ml-auto hidden md:inline-flex" onClick={editSelected}>Set company…</Button>
              <Button variant="outline" size="sm" className="hidden md:inline-flex" onClick={() => setExporting([...selectedIds])}>Export selected</Button>
              <Button variant="outline" size="sm" className="ml-auto text-destructive hover:text-destructive md:ml-0" onClick={confirmDeleteSelected}>Delete</Button>
            </>
          ) : (
            <div className="relative w-full max-w-md">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search contacts" aria-label="Search contacts" className="h-9 pl-9 touch:h-10"
                disabled={view === 'duplicates' || view === 'merged'} />
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
              onEdit={() => setEditor({ kind: 'edit', contact: active })} onDelete={() => confirmDelete(active)} onToggleFavorite={() => toggleFavorite(active)} />
          </aside>
        )}
      </div>

      <ContactEditor target={editor} onClose={() => setEditor(null)} actions={actions} />
      <BulkEditDialog contacts={bulkTargets} onClose={() => setBulkTargets(null)} actions={actions} onSaved={() => setSelectedIds(new Set())} />
      <MergeReviewDialog group={review} contacts={allContacts} onClose={() => setReview(null)} actions={actions} />
      <ContactImportDialog open={importing} onClose={() => setImporting(false)} onImported={() => { setSearch(''); }} />
      <ContactExportDialog target={exporting} onClose={() => setExporting(null)} actions={actions} />
      <AlertDialog open={!!confirm} onOpenChange={open => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={confirm?.destructive ? buttonVariants({ variant: 'destructive' }) : undefined} onClick={() => confirm?.run()}>{confirm?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
};

export default Contacts;
