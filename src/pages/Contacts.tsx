import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { 
  Plus, 
  Search, 
  Star, 
  StarOff, 
  Mail, 
  Phone, 
  Building, 
  Briefcase,
  Trash2,
  Edit,
  Users,
  Loader2,
  Upload,
  Download
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

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

const Contacts = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
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

  // Open new contact dialog if linked from dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'new') {
      setIsDialogOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Fetch contacts
  const { data: contacts = [], isLoading } = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const response = await api.get<{ contacts: Contact[] }>('/contacts');
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
      first_name: contact.first_name,
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
      const token = localStorage.getItem('auth_token');
      const response = await fetch('/api/contacts/export', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!response.ok) {
        const data = await response.json();
        toast({ title: 'Export failed', description: data.error, variant: 'destructive' });
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'contacts.vcf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast({ title: `Exported ${contacts.length} contacts` });
    } catch (error: any) {
      toast({ title: 'Export failed', description: error.message, variant: 'destructive' });
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
    } catch (error: any) {
      toast({ title: 'Import failed', description: error.message, variant: 'destructive' });
    }
  };

  const filteredContacts = contacts.filter((contact) => {
    const searchLower = searchQuery.toLowerCase();
    return (
      contact.first_name.toLowerCase().includes(searchLower) ||
      (contact.last_name?.toLowerCase() || '').includes(searchLower) ||
      (contact.email?.toLowerCase() || '').includes(searchLower) ||
      (contact.company?.toLowerCase() || '').includes(searchLower)
    );
  });

  const getInitials = (contact: Contact) => {
    const first = contact.first_name[0] || '';
    const last = contact.last_name?.[0] || '';
    return (first + last).toUpperCase();
  };

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
          <Button variant="outline" size="sm" onClick={handleExport} disabled={contacts.length === 0}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={(open) => {
            setIsDialogOpen(open);
            if (!open) resetForm();
          }}>
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
                  <Label htmlFor="first_name">First Name *</Label>
                  <Input
                    id="first_name"
                    value={formData.first_name}
                    onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                    required
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

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search contacts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10 max-w-sm"
        />
      </div>

      {/* Contacts Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
        </div>
      ) : filteredContacts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-1">
              {searchQuery ? 'No contacts found' : 'No contacts yet'}
            </h3>
            <p className="text-muted-foreground text-center mb-4">
              {searchQuery ? 'Try a different search term' : 'Add your first contact to get started'}
            </p>
            {!searchQuery && (
              <Button onClick={() => setIsDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Contact
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <motion.div 
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <AnimatePresence mode="popLayout">
            {filteredContacts.map((contact) => (
              <motion.div
                key={contact.id}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
              >
                <Card className="module-card-contacts group">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <Avatar className="h-12 w-12">
                        <AvatarImage src={contact.avatar_url || undefined} />
                        <AvatarFallback className="bg-contacts/10 text-contacts">
                          {getInitials(contact)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <h3 className="font-semibold text-foreground truncate">
                            {contact.first_name} {contact.last_name}
                          </h3>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => toggleFavorite.mutate({ 
                              id: contact.id, 
                              is_favorite: !contact.is_favorite 
                            })}
                          >
                            {contact.is_favorite ? (
                              <Star className="h-4 w-4 text-warning fill-warning" />
                            ) : (
                              <StarOff className="h-4 w-4 text-muted-foreground" />
                            )}
                          </Button>
                        </div>
                        {contact.job_title && (
                          <p className="text-sm text-muted-foreground truncate">
                            {contact.job_title}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 space-y-2">
                      {contact.email && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Mail className="h-3.5 w-3.5" />
                          <span className="truncate">{contact.email}</span>
                        </div>
                      )}
                      {contact.phone && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Phone className="h-3.5 w-3.5 shrink-0" />
                          <a
                            href={`tel:${contact.phone.replace(/\s/g, '')}`}
                            className="truncate hover:underline focus:underline focus:outline-none text-muted-foreground hover:text-foreground"
                            aria-label={`Call ${contact.phone}`}
                          >
                            {contact.phone}
                          </a>
                        </div>
                      )}
                      {contact.company && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Building className="h-3.5 w-3.5" />
                          <span className="truncate">{contact.company}</span>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="mt-4 pt-3 border-t border-border flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(contact)}
                      >
                        <Edit className="h-4 w-4 mr-1" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => deleteContact.mutate(contact.id)}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        Delete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
};

export default Contacts;
