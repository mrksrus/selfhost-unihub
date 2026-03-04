import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Search,
  Star,
  StarOff,
  Mail,
  Phone,
  Building,
  Trash2,
  Edit,
  Users,
  Loader2,
  Upload,
  Download,
} from 'lucide-react';

type ContactGroup = 'all' | 'name_only' | 'number_or_email_only' | 'duplicates';

interface Contact {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  job_title: string | null;
  notes: string | null;
  avatar_url: string | null;
  is_favorite: boolean;
}

interface MergeDuplicatesResult {
  merged: number;
  removed: number;
  groups: number;
  message: string;
}

interface MergePreviewGroup {
  key: string;
  size: number;
  keep: { id: string; name: string; email: string | null; phone: string | null };
  remove: Array<{ id: string; name: string; email: string | null; phone: string | null }>;
}

interface MergePreviewResult {
  groups: number;
  to_remove: number;
  merge_target_count: number;
  preview: MergePreviewGroup[];
}

const SEARCH_DEBOUNCE_MS = 300;

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

const Contacts = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [group, setGroup] = useState<ContactGroup>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [mergePreview, setMergePreview] = useState<MergePreviewResult | null>(null);
  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    company: '',
    job_title: '',
    notes: '',
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const debouncedSearch = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);

  const normalizeEmail = (value: string | null | undefined) => (value || '').trim().toLowerCase();
  const normalizePhone = (value: string | null | undefined) => (value || '').replace(/[^\d+]/g, '');
  const normalizeName = (value: string | null | undefined) => (value || '').trim().toLowerCase();
  const getDuplicateKey = (contact: Contact) => {
    const email = normalizeEmail(contact.email);
    if (email) return `e:${email}`;
    const phone = normalizePhone(contact.phone);
    if (phone) return `p:${phone}`;
    const first = normalizeName(contact.first_name);
    const last = normalizeName(contact.last_name);
    if (first || last) return `n:${first}|${last}`;
    return null;
  };

  // Open new contact dialog if linked from dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'new') {
      setIsDialogOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Fetch all contacts once, then filter on the client.
  // This avoids blank lists when server-side group filters drift from UI logic.
  const { data: allContacts = [], isLoading, error: contactsError } = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const response = await api.get<{ contacts: Contact[] }>('/contacts');
      if (response.error) throw new Error(response.error);
      const list = response.data?.contacts;
      return Array.isArray(list) ? list : [];
    },
    // Cache contacts for a while and avoid refetching on every tab focus/reconnect.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const duplicateMeta = useMemo(() => {
    const groups = new Map<string, Contact[]>();
    for (const contact of allContacts) {
      const key = getDuplicateKey(contact);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(contact);
    }

    const duplicateIds = new Set<string>();
    const duplicateGroupKeyById = new Map<string, string>();
    const duplicateGroupSizeById = new Map<string, number>();

    for (const [key, members] of groups.entries()) {
      if (members.length < 2) continue;
      for (const member of members) {
        duplicateIds.add(member.id);
        duplicateGroupKeyById.set(member.id, key);
        duplicateGroupSizeById.set(member.id, members.length);
      }
    }

    return { duplicateIds, duplicateGroupKeyById, duplicateGroupSizeById };
  }, [allContacts]);

  const contacts = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();

    const inGroup = (contact: Contact) => {
      const hasName = Boolean((contact.first_name || '').trim() || (contact.last_name || '').trim());
      const hasEmail = Boolean((contact.email || '').trim());
      const hasPhone = Boolean((contact.phone || '').trim());

      if (group === 'name_only') return hasName && !hasEmail && !hasPhone;
      if (group === 'number_or_email_only') return !hasName && (hasEmail || hasPhone);
      if (group === 'duplicates') return duplicateMeta.duplicateIds.has(contact.id);
      return true;
    };

    const matchesSearch = (contact: Contact) => {
      if (!query) return true;
      const haystack = [
        contact.first_name,
        contact.last_name,
        contact.email,
        contact.phone,
        contact.company,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    };

    const filtered = allContacts.filter((contact) => inGroup(contact) && matchesSearch(contact));

    if (group === 'duplicates') {
      return [...filtered].sort((a, b) => {
        const keyA = duplicateMeta.duplicateGroupKeyById.get(a.id) || '';
        const keyB = duplicateMeta.duplicateGroupKeyById.get(b.id) || '';
        if (keyA !== keyB) return keyA.localeCompare(keyB);

        const nameA = `${a.first_name || ''} ${a.last_name || ''}`.trim().toLowerCase();
        const nameB = `${b.first_name || ''} ${b.last_name || ''}`.trim().toLowerCase();
        return nameA.localeCompare(nameB);
      });
    }

    return filtered;
  }, [allContacts, debouncedSearch, group, duplicateMeta]);

  // Create contact mutation
  const createContact = useMutation({
    mutationFn: async (contact: typeof formData) => {
      const response = await api.post('/contacts', contact);
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-count'] });
      toast({ title: 'Contact created successfully' });
      resetForm();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create contact', description: error.message, variant: 'destructive' });
    },
  });

  // Update contact mutation
  const updateContact = useMutation({
    mutationFn: async ({ id, ...contact }: Partial<Contact> & { id: string }) => {
      const response = await api.put(`/contacts/${id}`, contact);
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast({ title: 'Contact updated successfully' });
      resetForm();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update contact', description: error.message, variant: 'destructive' });
    },
  });

  // Delete contact mutation
  const deleteContact = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.delete(`/contacts/${id}`);
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-count'] });
      toast({ title: 'Contact deleted successfully' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete contact', description: error.message, variant: 'destructive' });
    },
  });

  // Bulk delete mutation
  const bulkDeleteContacts = useMutation({
    mutationFn: async (ids: string[]) => {
      const response = await api.post<{ deleted: number }>('/contacts/bulk-delete', { ids });
      if (response.error) throw new Error(response.error);
      return response.data?.deleted ?? ids.length;
    },
    onSuccess: (deleted) => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-count'] });
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
      toast({ title: `${deleted} contact(s) deleted` });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete contacts', description: error.message, variant: 'destructive' });
    },
  });

  // Toggle favorite mutation
  const toggleFavorite = useMutation({
    mutationFn: async ({ id, is_favorite }: { id: string; is_favorite: boolean }) => {
      const response = await api.put(`/contacts/${id}/favorite`, { is_favorite });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
  });

  const mergeDuplicates = useMutation({
    mutationFn: async () => {
      const response = await api.post<MergeDuplicatesResult>('/contacts/merge-duplicates', {});
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-count'] });
      setSelectedIds(new Set());
      toast({
        title: 'Duplicate merge finished (Alpha)',
        description: data?.message || 'Done.',
      });
    },
    onError: (error: Error) => {
      toast({ title: 'Duplicate merge failed (Alpha)', description: error.message, variant: 'destructive' });
    },
  });

  const previewMergeDuplicates = useMutation({
    mutationFn: async () => {
      const response = await api.post<MergePreviewResult>('/contacts/merge-duplicates/preview', {});
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (data) => {
      setMergePreview(data || null);
      toast({
        title: 'Duplicate merge preview ready (Alpha)',
        description: data?.groups ? `${data.groups} group(s) would be merged.` : 'No duplicates detected.',
      });
    },
    onError: (error: Error) => {
      toast({ title: 'Preview failed (Alpha)', description: error.message, variant: 'destructive' });
    },
  });

  const resetForm = () => {
    setFormData({
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      company: '',
      job_title: '',
      notes: '',
    });
    setEditingContact(null);
    setIsDialogOpen(false);
  };

  const handleEdit = (contact: Contact) => {
    setEditingContact(contact);
    setFormData({
      first_name: contact.first_name || '',
      last_name: contact.last_name || '',
      email: contact.email || '',
      phone: contact.phone || '',
      company: contact.company || '',
      job_title: contact.job_title || '',
      notes: contact.notes || '',
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingContact) {
      updateContact.mutate({ id: editingContact.id, ...formData });
    } else {
      createContact.mutate(formData);
    }
  };

  const handleExport = async () => {
    try {
      const { blob, filename } = await api.getBlob('/contacts/export');
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'contacts.vcf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast({ title: `Exported contacts` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Export failed';
      toast({ title: 'Export failed', description: message, variant: 'destructive' });
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = '';

    if (!file.name.toLowerCase().endsWith('.vcf')) {
      toast({ title: 'Invalid file', description: 'Please select a .vcf (vCard) file', variant: 'destructive' });
      return;
    }

    try {
      const text = await file.text();
      const response = await api.post<{ message: string; imported: number; total: number; errors?: string[] }>(
        '/contacts/import',
        { vcf_data: text }
      );

      if (response.error) {
        toast({ title: 'Import failed', description: response.error, variant: 'destructive' });
        return;
      }

      const data = response.data!;
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-count'] });
      setSearchQuery('');
      setGroup('all');
      setMergePreview(null);

      if (data.errors && data.errors.length > 0) {
        toast({
          title: `Imported ${data.imported} of ${data.total} contacts`,
          description: `${data.errors.length} failed`,
          variant: 'destructive',
        });
      } else {
        toast({ title: data.message });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Import failed';
      toast({ title: 'Import failed', description: message, variant: 'destructive' });
    }
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === contacts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(contacts.map((c) => c.id)));
    }
  }, [contacts, selectedIds.size]);

  const handleBulkDelete = () => {
    bulkDeleteContacts.mutate(Array.from(selectedIds));
  };

  const getDisplayName = (contact: Contact) => {
    const first = (contact.first_name || '').trim();
    const last = (contact.last_name || '').trim();
    if (first || last) return [first, last].filter(Boolean).join(' ');
    if (contact.email) return contact.email;
    if (contact.phone) return contact.phone;
    return 'No name';
  };

  const getInitials = (contact: Contact) => {
    const first = (contact.first_name || '')[0] || '';
    const last = (contact.last_name || '')[0] || '';
    if (first || last) return (first + last).toUpperCase();
    if (contact.email) return contact.email[0].toUpperCase();
    if (contact.phone) return '#';
    return '?';
  };

  const selectedCount = selectedIds.size;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Contacts</h1>
          <p className="text-muted-foreground">Manage your contacts in one place</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".vcf"
            className="hidden"
            onChange={handleImport}
          />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
          <Dialog
            open={isDialogOpen}
            onOpenChange={(open) => {
              setIsDialogOpen(open);
              if (!open) resetForm();
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Contact
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{editingContact ? 'Edit Contact' : 'Add New Contact'}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="first_name">First Name {!editingContact && '*'}</Label>
                    <Input
                      id="first_name"
                      value={formData.first_name}
                      onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                      required={!editingContact}
                      placeholder={editingContact ? 'Optional' : 'Required for new contacts'}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="last_name">Last Name</Label>
                    <Input
                      id="last_name"
                      value={formData.last_name}
                      onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="company">Company</Label>
                    <Input
                      id="company"
                      value={formData.company}
                      onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="job_title">Job Title</Label>
                    <Input
                      id="job_title"
                      value={formData.job_title}
                      onChange={(e) => setFormData({ ...formData, job_title: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={3}
                  />
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <Button type="button" variant="outline" onClick={resetForm}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createContact.isPending || updateContact.isPending}>
                    {(createContact.isPending || updateContact.isPending) && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    {editingContact ? 'Save Changes' : 'Add Contact'}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Group tabs */}
      <Tabs value={group} onValueChange={(v) => setGroup(v as ContactGroup)} className="mb-4">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="name_only">Name only</TabsTrigger>
          <TabsTrigger value="number_or_email_only">Number or email only</TabsTrigger>
          <TabsTrigger value="duplicates">Duplicates</TabsTrigger>
        </TabsList>
        <p className="text-xs text-muted-foreground mt-1">
          {group === 'name_only' && 'Contacts with a name but no email or phone — add details or delete.'}
          {group === 'number_or_email_only' && 'Contacts with only email/phone — add a name.'}
          {group === 'duplicates' && 'Possible duplicates grouped together for review. Auto Merge is alpha.'}
          {group === 'all' && 'All contacts.'}
        </p>
      </Tabs>

      {/* Search */}
      <div className="relative mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        {selectedCount > 0 && (
          <>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
              disabled={bulkDeleteContacts.isPending}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete {selectedCount} selected
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
              Clear selection
            </Button>
          </>
        )}
        {group === 'duplicates' && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => previewMergeDuplicates.mutate()}
              disabled={previewMergeDuplicates.isPending}
            >
              {previewMergeDuplicates.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Preview Auto Merge (Alpha)
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => mergeDuplicates.mutate()}
              disabled={mergeDuplicates.isPending}
            >
              {mergeDuplicates.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Run Auto Merge (Alpha)
            </Button>
          </>
        )}
      </div>

      {group === 'duplicates' && mergePreview && (
        <Card className="mb-4">
          <CardContent className="py-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Alpha preview: {mergePreview.groups} group(s) detected, {mergePreview.to_remove} contact(s) would be removed.
            </p>
            {mergePreview.preview.slice(0, 8).map((item) => (
              <div key={item.key} className="text-sm border rounded-md p-3">
                <p className="font-medium mb-1">
                  Group of {item.size}: keep <span className="text-foreground">{item.keep.name}</span>
                </p>
                <p className="text-muted-foreground">
                  Remove: {item.remove.map((r) => r.name).join(', ') || 'none'}
                </p>
              </div>
            ))}
            {mergePreview.preview.length > 8 && (
              <p className="text-xs text-muted-foreground">
                Showing first 8 groups. Run the merge to process all {mergePreview.preview.length}.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedCount} contact(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {bulkDeleteContacts.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Contacts list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
        </div>
      ) : contactsError ? (
        <Card>
          <CardContent className="py-8">
            <h3 className="text-lg font-medium text-foreground mb-2">Failed to load contacts</h3>
            <p className="text-muted-foreground">
              {contactsError instanceof Error ? contactsError.message : 'Unknown error'}
            </p>
          </CardContent>
        </Card>
      ) : contacts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-1">
              {searchQuery || group !== 'all' ? 'No contacts found' : 'No contacts yet'}
            </h3>
            <p className="text-muted-foreground text-center mb-4">
              {searchQuery || group !== 'all'
                ? 'Try a different search or group'
                : 'Add your first contact to get started'}
            </p>
            {!searchQuery && group === 'all' && (
              <Button onClick={() => setIsDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Contact
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 pr-0">
                  <Checkbox
                    checked={contacts.length > 0 && selectedIds.size === contacts.length}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead className="w-12">Favorite</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Company</TableHead>
                <TableHead className="text-right w-28">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell className="pr-0">
                    <Checkbox
                      checked={selectedIds.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                      aria-label={`Select ${getDisplayName(contact)}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() =>
                        toggleFavorite.mutate({
                          id: contact.id,
                          is_favorite: !contact.is_favorite,
                        })
                      }
                    >
                      {contact.is_favorite ? (
                        <Star className="h-4 w-4 text-warning fill-warning" />
                      ) : (
                        <StarOff className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-8 w-8">
                        <AvatarImage src={contact.avatar_url || undefined} />
                        <AvatarFallback className="bg-contacts/10 text-contacts text-xs">
                          {getInitials(contact)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <span className="font-medium">{getDisplayName(contact)}</span>
                        {group === 'duplicates' && duplicateMeta.duplicateGroupSizeById.get(contact.id) && (
                          <p className="text-xs text-warning">
                            Possible duplicate group ({duplicateMeta.duplicateGroupSizeById.get(contact.id)})
                          </p>
                        )}
                        {contact.job_title && (
                          <p className="text-xs text-muted-foreground">{contact.job_title}</p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {contact.email ? (
                      <a
                        href={`mailto:${contact.email}`}
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 truncate max-w-[200px]"
                      >
                        <Mail className="h-3.5 w-3.5 shrink-0" />
                        {contact.email}
                      </a>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {contact.phone ? (
                      <a
                        href={`tel:${contact.phone.replace(/\s/g, '')}`}
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                      >
                        <Phone className="h-3.5 w-3.5 shrink-0" />
                        {contact.phone}
                      </a>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {contact.company ? (
                      <span className="inline-flex items-center gap-1 truncate max-w-[150px]">
                        <Building className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        {contact.company}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(contact)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => deleteContact.mutate(contact.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
};

export default Contacts;
