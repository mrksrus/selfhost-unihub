import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { 
  Plus, 
  Inbox, 
  Send, 
  Trash2, 
  Star, 
  Archive,
  Mail,
  Settings,
  Loader2,
  RefreshCw,
  PenSquare
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';

interface MailAccount {
  id: string;
  email_address: string;
  display_name: string | null;
  provider: string;
  is_active: boolean;
  last_synced_at: string | null;
}

interface Email {
  id: string;
  mail_account_id: string;
  subject: string | null;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  body_text: string | null;
  folder: string;
  is_read: boolean;
  is_starred: boolean;
  received_at: string;
}

const mailProviders = [
  { value: 'gmail', label: 'Gmail', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' },
  { value: 'outlook', label: 'Outlook / Hotmail', imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com' },
  { value: 'yahoo', label: 'Yahoo Mail', imapHost: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com' },
  { value: 'icloud', label: 'iCloud Mail', imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com' },
  { value: 'custom', label: 'Custom IMAP', imapHost: '', smtpHost: '' },
];

const folders = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];

const MailPage = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState('inbox');
  const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [accountForm, setAccountForm] = useState({
    email_address: '',
    display_name: '',
    provider: '',
    imap_host: '',
    smtp_host: '',
  });

  // Fetch mail accounts
  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: async () => {
      const response = await api.get<{ accounts: MailAccount[] }>('/mail/accounts');
      if (response.error) throw new Error(response.error);
      return response.data?.accounts || [];
    },
  });

  // Fetch emails for selected account
  const { data: emails = [], isLoading: emailsLoading } = useQuery({
    queryKey: ['emails', selectedAccount, selectedFolder],
    queryFn: async () => {
      if (!selectedAccount) return [];
      
      const folder = selectedFolder === 'starred' ? 'inbox' : selectedFolder;
      const response = await api.get<{ emails: Email[] }>(`/mail/emails?account_id=${selectedAccount}&folder=${folder}`);
      if (response.error) throw new Error(response.error);
      let emails = response.data?.emails || [];
      
      if (selectedFolder === 'starred') {
        emails = emails.filter(e => e.is_starred);
      }
      
      return emails;
    },
    enabled: !!selectedAccount,
  });

  // Add mail account mutation
  const addAccount = useMutation({
    mutationFn: async (account: typeof accountForm) => {
      const response = await api.post('/mail/accounts', {
        ...account,
        imap_port: 993,
        smtp_port: 587,
      });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts-count'] });
      toast({ title: 'Mail account added successfully' });
      setIsAddAccountOpen(false);
      setAccountForm({
        email_address: '',
        display_name: '',
        provider: '',
        imap_host: '',
        smtp_host: '',
      });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to add mail account', description: error.message, variant: 'destructive' });
    },
  });

  // Delete account mutation
  const deleteAccount = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.delete(`/mail/accounts/${id}`);
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts-count'] });
      setSelectedAccount(null);
      toast({ title: 'Mail account removed' });
    },
  });

  // Toggle star mutation
  const toggleStar = useMutation({
    mutationFn: async ({ id, is_starred }: { id: string; is_starred: boolean }) => {
      const response = await api.put(`/mail/emails/${id}/star`, { is_starred });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
    },
  });

  // Mark as read mutation
  const markAsRead = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.put(`/mail/emails/${id}/read`, { is_read: true });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['unread-emails-count'] });
    },
  });

  const handleProviderChange = (provider: string) => {
    const providerConfig = mailProviders.find(p => p.value === provider);
    setAccountForm({
      ...accountForm,
      provider,
      imap_host: providerConfig?.imapHost || '',
      smtp_host: providerConfig?.smtpHost || '',
    });
  };

  const handleAddAccount = (e: React.FormEvent) => {
    e.preventDefault();
    addAccount.mutate(accountForm);
  };

  const selectedAccountData = accounts.find(a => a.id === selectedAccount);

  return (
    <div className="flex h-[calc(100vh-0px)] overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 border-r border-border bg-card flex flex-col">
        {/* Compose Button */}
        <div className="p-4">
          <Button className="w-full" onClick={() => setIsComposeOpen(true)}>
            <PenSquare className="h-4 w-4 mr-2" />
            Compose
          </Button>
        </div>

        {/* Folders */}
        <nav className="px-2 space-y-1">
          {folders.map((folder) => (
            <button
              key={folder.id}
              onClick={() => setSelectedFolder(folder.id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                selectedFolder === folder.id
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <folder.icon className="h-4 w-4" />
              {folder.label}
            </button>
          ))}
        </nav>

        {/* Accounts */}
        <div className="flex-1 overflow-auto mt-6">
          <div className="px-4 pb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Accounts
            </span>
            <Dialog open={isAddAccountOpen} onOpenChange={setIsAddAccountOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <Plus className="h-4 w-4" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Mail Account</DialogTitle>
                  <DialogDescription>
                    Connect an email account to view and manage your mail.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleAddAccount} className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="provider">Email Provider</Label>
                    <Select 
                      value={accountForm.provider} 
                      onValueChange={handleProviderChange}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {mailProviders.map((provider) => (
                          <SelectItem key={provider.value} value={provider.value}>
                            {provider.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email_address">Email Address</Label>
                    <Input
                      id="email_address"
                      type="email"
                      value={accountForm.email_address}
                      onChange={(e) => setAccountForm({ ...accountForm, email_address: e.target.value })}
                      placeholder="you@example.com"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="display_name">Display Name</Label>
                    <Input
                      id="display_name"
                      value={accountForm.display_name}
                      onChange={(e) => setAccountForm({ ...accountForm, display_name: e.target.value })}
                      placeholder="John Doe"
                    />
                  </div>
                  {accountForm.provider === 'custom' && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="imap_host">IMAP Host</Label>
                        <Input
                          id="imap_host"
                          value={accountForm.imap_host}
                          onChange={(e) => setAccountForm({ ...accountForm, imap_host: e.target.value })}
                          placeholder="imap.example.com"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="smtp_host">SMTP Host</Label>
                        <Input
                          id="smtp_host"
                          value={accountForm.smtp_host}
                          onChange={(e) => setAccountForm({ ...accountForm, smtp_host: e.target.value })}
                          placeholder="smtp.example.com"
                        />
                      </div>
                    </>
                  )}
                  <div className="flex justify-end gap-3 pt-2">
                    <Button type="button" variant="outline" onClick={() => setIsAddAccountOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={addAccount.isPending}>
                      {addAccount.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Add Account
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
          
          <div className="px-2 space-y-1">
            {accountsLoading ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : accounts.length === 0 ? (
              <div className="px-3 py-4 text-center">
                <Mail className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
                <p className="text-sm text-muted-foreground">No accounts yet</p>
              </div>
            ) : (
              accounts.map((account) => (
                <button
                  key={account.id}
                  onClick={() => setSelectedAccount(account.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    selectedAccount === account.id
                      ? 'bg-mail/10 text-mail font-medium'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <div className="w-8 h-8 rounded-full bg-mail/10 flex items-center justify-center text-mail text-xs font-medium">
                    {account.email_address[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="truncate">{account.display_name || account.email_address}</p>
                    <p className="text-xs text-muted-foreground truncate">{account.email_address}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="h-14 border-b border-border flex items-center justify-between px-4">
          <h2 className="font-semibold capitalize">{selectedFolder}</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon">
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Email List */}
        <div className="flex-1 overflow-auto">
          {!selectedAccount ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <Mail className="h-16 w-16 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">No account selected</h3>
              <p className="text-muted-foreground mb-4 max-w-sm">
                Select an email account from the sidebar or add a new one to get started.
              </p>
              <Button onClick={() => setIsAddAccountOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Mail Account
              </Button>
            </div>
          ) : emailsLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-8 w-8 animate-spin text-accent" />
            </div>
          ) : emails.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <Inbox className="h-16 w-16 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">
                No emails in {selectedFolder}
              </h3>
              <p className="text-muted-foreground">
                {selectedFolder === 'inbox' 
                  ? 'Your inbox is empty. Sync your account to fetch emails.'
                  : `No emails in your ${selectedFolder} folder.`
                }
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              <AnimatePresence mode="popLayout">
                {emails.map((email) => (
                  <motion.div
                    key={email.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className={`flex items-start gap-4 p-4 hover:bg-muted/50 cursor-pointer transition-colors ${
                      !email.is_read ? 'bg-accent/5' : ''
                    }`}
                    onClick={() => !email.is_read && markAsRead.mutate(email.id)}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 h-8 w-8"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStar.mutate({ id: email.id, is_starred: !email.is_starred });
                      }}
                    >
                      <Star className={`h-4 w-4 ${email.is_starred ? 'fill-warning text-warning' : 'text-muted-foreground'}`} />
                    </Button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className={`font-medium truncate ${!email.is_read ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {email.from_name || email.from_address}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {format(new Date(email.received_at), 'MMM d')}
                        </span>
                      </div>
                      <p className={`truncate ${!email.is_read ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {email.subject || '(No subject)'}
                      </p>
                      <p className="text-sm text-muted-foreground truncate mt-0.5">
                        {email.body_text?.substring(0, 100) || '(No content)'}
                      </p>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* Compose Dialog */}
      <Dialog open={isComposeOpen} onOpenChange={setIsComposeOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New Message</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label>From</Label>
              <Select value={selectedAccount || ''} onValueChange={setSelectedAccount}>
                <SelectTrigger>
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.email_address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>To</Label>
              <Input placeholder="recipient@example.com" />
            </div>
            <div className="space-y-2">
              <Label>Subject</Label>
              <Input placeholder="Enter subject" />
            </div>
            <div className="space-y-2">
              <Label>Message</Label>
              <textarea 
                className="w-full min-h-[200px] p-3 rounded-md border border-input bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Write your message..."
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setIsComposeOpen(false)}>
                Cancel
              </Button>
              <Button>
                <Send className="h-4 w-4 mr-2" />
                Send
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default MailPage;
