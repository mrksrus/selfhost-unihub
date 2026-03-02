import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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

type ContactGroup = 'all' | 'name_only' | 'number_or_email_only';

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

  // Open new contact dialog if linked from dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'new') {
      setIsDialogOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Fetch contacts with server-side search and group filter
  const { data: contacts = [], isLoading } = useQuery({
    queryKey: ['contacts', debouncedSearch, group],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (group !== 'all') params.set('group', group);
      const response = await api.get<{ contacts: Contact[] }>(
        `/contacts?${params.toString()}`
      );
      if (response.error) throw new Error(response.error);
      return response.data?.contacts || [];
    },
  });

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
        </TabsList>
        <p className="text-xs text-muted-foreground mt-1">
          {group === 'name_only' && 'Contacts with a name but no email or phone — add details or delete.'}
          {group === 'number_or_email_only' && 'Contacts with only email/phone — add a name.'}
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
      </div>

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
