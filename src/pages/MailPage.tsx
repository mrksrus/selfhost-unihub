import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { 
  AlertDialog, 
  AlertDialogAction, 
  AlertDialogCancel, 
  AlertDialogContent, 
  AlertDialogDescription, 
  AlertDialogFooter, 
  AlertDialogHeader, 
  AlertDialogTitle 
} from '@/components/ui/alert-dialog';
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  Loader2,
  RefreshCw,
  PenSquare,
  MoreVertical,
  X,
  Edit,
  Reply,
  Forward,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Menu,
  CheckSquare,
  Square,
  FolderOpen,
  CheckCircle2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { useIsMobile } from '@/hooks/use-mobile';

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
  body_html: string | null;
  folder: string;
  is_read: boolean;
  is_starred: boolean;
  received_at: string;
}

const mailProviders = [
  { value: 'gmail', label: 'Gmail', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', imapPort: 993, smtpPort: 587 },
  { value: 'yahoo', label: 'Yahoo Mail', imapHost: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com', imapPort: 993, smtpPort: 587 },
  { value: 'icloud', label: 'iCloud Mail', imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', imapPort: 993, smtpPort: 587 },
  { value: 'outlook', label: 'Outlook / Office 365', imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', imapPort: 993, smtpPort: 587 },
  { value: 'exchange', label: 'Exchange (On-Premise)', imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 587 },
  { value: 'custom', label: 'Other (Custom IMAP/SMTP)', imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 587 },
];

const folders = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];

const MailPage = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState('inbox');
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<'new' | 'reply' | 'forward'>('new');
  const [isReplying, setIsReplying] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<string | null>(null);
  const [editingAccount, setEditingAccount] = useState<MailAccount | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [contextMenuEmail, setContextMenuEmail] = useState<{ email: Email; x: number; y: number } | null>(null);
  const [composeForm, setComposeForm] = useState({
    to: '',
    subject: '',
    body: '',
  });
  const [accountForm, setAccountForm] = useState({
    email_address: '',
    display_name: '',
    provider: '',
    username: '',
    password: '',
    imap_host: '',
    smtp_host: '',
    imap_port: 993,
    smtp_port: 587,
  });

  // Open compose dialog if linked from dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'compose') {
      setIsComposeOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Auto-select first account or remember last selected
  useEffect(() => {
    if (accounts.length > 0 && !selectedAccount) {
      // Try to restore last selected account from localStorage
      const lastAccountId = localStorage.getItem('mail_last_selected_account');
      const lastAccount = accounts.find(a => a.id === lastAccountId);
      
      if (lastAccount) {
        setSelectedAccount(lastAccount.id);
      } else {
        // Default to first account
        setSelectedAccount(accounts[0].id);
      }
    }
  }, [accounts, selectedAccount]);

  // Remember selected account
  useEffect(() => {
    if (selectedAccount) {
      localStorage.setItem('mail_last_selected_account', selectedAccount);
    }
  }, [selectedAccount]);

  // Clear selection when folder changes
  useEffect(() => {
    setSelectedEmails(new Set());
  }, [selectedFolder, selectedAccount]);

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
        encrypted_password: account.password, // Will be encrypted on server
      });
      if (response.error) {
        const errorDetails = response.details ? `\n\nTechnical details:\n${response.details}` : '';
        throw new Error(response.error + errorDetails);
      }
      return response.data;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts-count'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      
      // Handle timeout case (sync in progress)
      const syncMsg = data?.syncInProgress 
        ? data.message || 'Account added. Email sync is running in the background — this may take several minutes for large mailboxes.'
        : data?.syncResult?.message || 'Account added';
      
      toast({ 
        title: '✓ Account connected successfully', 
        description: syncMsg,
        duration: 10000,
      });
      
      setIsAddAccountOpen(false);
      setAccountForm({
        email_address: '',
        display_name: '',
        provider: '',
        username: '',
        password: '',
        imap_host: '',
        smtp_host: '',
        imap_port: 993,
        smtp_port: 587,
      });
    },
    onError: (error: Error) => {
      const errorLines = error.message.split('\n');
      const mainError = errorLines[0];
      const details = errorLines.slice(1).join('\n');
      
      toast({ 
        title: 'Failed to add mail account', 
        description: (
          <div className="space-y-2">
            <p>{mainError}</p>
            {details && (
              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all select-all">
                {details}
              </pre>
            )}
          </div>
        ),
        variant: 'destructive',
        duration: 10000,
      });
    },
  });

  // Update account mutation
  const updateAccount = useMutation({
    mutationFn: async ({ id, ...data }: { id: string } & Partial<typeof accountForm>) => {
      const response = await api.put(`/mail/accounts/${id}`, {
        ...data,
        encrypted_password: data.password || undefined,
      });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      toast({ title: '✓ Account updated successfully' });
      setEditingAccount(null);
      setIsAddAccountOpen(false);
      setAccountForm({
        email_address: '',
        display_name: '',
        provider: '',
        username: '',
        password: '',
        imap_host: '',
        smtp_host: '',
        imap_port: 993,
        smtp_port: 587,
      });
    },
    onError: (error: Error) => {
      toast({ 
        title: 'Failed to update account', 
        description: error.message, 
        variant: 'destructive' 
      });
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
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      setSelectedAccount(null);
      setAccountToDelete(null);
      toast({ title: 'Mail account and all associated emails deleted' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete account', description: error.message, variant: 'destructive' });
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
      queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  // Bulk operations mutations
  const bulkDelete = useMutation({
    mutationFn: async (emailIds: string[]) => {
      const response = await api.post('/mail/emails/bulk-delete', { email_ids: emailIds });
      if (response.error) throw new Error(response.error);
      return emailIds.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      setSelectedEmails(new Set());
      toast({ title: `✓ Deleted ${count} email(s)` });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete emails', description: error.message, variant: 'destructive' });
    },
  });

  const bulkMove = useMutation({
    mutationFn: async ({ emailIds, folder }: { emailIds: string[]; folder: string }) => {
      const response = await api.post('/mail/emails/bulk-move', { email_ids: emailIds, folder });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      setSelectedEmails(new Set());
      toast({ title: `✓ Moved ${variables.emailIds.length} email(s) to ${variables.folder}` });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to move emails', description: error.message, variant: 'destructive' });
    },
  });

  const bulkMarkRead = useMutation({
    mutationFn: async ({ emailIds, is_read }: { emailIds: string[]; is_read: boolean }) => {
      const response = await api.post('/mail/emails/bulk-update', { email_ids: emailIds, is_read });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      setSelectedEmails(new Set());
    },
  });

  const bulkStar = useMutation({
    mutationFn: async ({ emailIds, is_starred }: { emailIds: string[]; is_starred: boolean }) => {
      const response = await api.post('/mail/emails/bulk-update', { email_ids: emailIds, is_starred });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      setSelectedEmails(new Set());
    },
  });

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts if user is typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Delete selected emails
      if (e.key === 'Delete' && selectedEmails.size > 0) {
        e.preventDefault();
        bulkDelete.mutate(Array.from(selectedEmails));
      }

      // Select all (Ctrl+A or Cmd+A)
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        if (emails.length > 0) {
          setSelectedEmails(new Set(emails.map(e => e.id)));
        }
      }

      // Escape to deselect all
      if (e.key === 'Escape') {
        setSelectedEmails(new Set());
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedEmails, emails, bulkDelete]);

  // Handle email selection
  const handleEmailSelect = (emailId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSelected = new Set(selectedEmails);
    if (newSelected.has(emailId)) {
      newSelected.delete(emailId);
    } else {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click: toggle selection
        newSelected.add(emailId);
      } else if (e.shiftKey && selectedEmails.size > 0) {
        // Shift+Click: select range
        const emailIds = emails.map(e => e.id);
        const startIdx = emailIds.findIndex(id => selectedEmails.has(id));
        const endIdx = emailIds.findIndex(id => id === emailId);
        if (startIdx !== -1 && endIdx !== -1) {
          const start = Math.min(startIdx, endIdx);
          const end = Math.max(startIdx, endIdx);
          for (let i = start; i <= end; i++) {
            newSelected.add(emailIds[i]);
          }
        } else {
          newSelected.add(emailId);
        }
      } else {
        // Regular click: single select
        newSelected.clear();
        newSelected.add(emailId);
      }
    }
    setSelectedEmails(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedEmails.size === emails.length) {
      setSelectedEmails(new Set());
    } else {
      setSelectedEmails(new Set(emails.map(e => e.id)));
    }
  };
  
  // Sync mail mutation
  const syncMail = useMutation({
    mutationFn: async (account_id: string) => {
      const response = await api.post('/mail/sync', { account_id });
      if (response.error) {
        const errorDetails = response.details ? `\n\nTechnical details:\n${response.details}` : '';
        throw new Error(response.error + errorDetails);
      }
      return response.data;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      
      const msg = data.message || `${data.newEmails || 0} new emails`;
      toast({ 
        title: '✓ Sync complete', 
        description: msg
      });
    },
    onError: (error: Error) => {
      const errorLines = error.message.split('\n');
      const mainError = errorLines[0];
      const details = errorLines.slice(1).join('\n');
      
      toast({ 
        title: 'Sync failed', 
        description: (
          <div className="space-y-2">
            <p>{mainError}</p>
            {details && (
              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all select-all">
                {details}
              </pre>
            )}
          </div>
        ),
        variant: 'destructive',
        duration: 10000,
      });
    },
  });
  
  // Send email mutation
  const sendEmailMutation = useMutation({
    mutationFn: async (data: { account_id: string; to: string; subject: string; body: string }) => {
      const response = await api.post('/mail/send', data);
      if (response.error) {
        const errorDetails = response.details ? `\n\nTechnical details:\n${response.details}` : '';
        throw new Error(response.error + errorDetails);
      }
      return response.data;
    },
    onSuccess: () => {
      toast({ title: '✓ Email sent successfully' });
      setIsComposeOpen(false);
      setIsReplying(false);
      setComposeMode('new');
      setComposeForm({ to: '', subject: '', body: '' });
    },
    onError: (error: Error) => {
      const errorLines = error.message.split('\n');
      const mainError = errorLines[0];
      const details = errorLines.slice(1).join('\n');
      
      toast({ 
        title: 'Failed to send email', 
        description: (
          <div className="space-y-2">
            <p>{mainError}</p>
            {details && (
              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all select-all">
                {details}
              </pre>
            )}
          </div>
        ),
        variant: 'destructive',
        duration: 10000,
      });
    },
  });

  const handleProviderChange = (provider: string) => {
    const providerConfig = mailProviders.find(p => p.value === provider);
    setAccountForm({
      ...accountForm,
      provider,
      imap_host: providerConfig?.imapHost || '',
      smtp_host: providerConfig?.smtpHost || '',
      imap_port: providerConfig?.imapPort || 993,
      smtp_port: providerConfig?.smtpPort || 587,
    });
  };

  const handleAddAccount = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingAccount) {
      updateAccount.mutate({ id: editingAccount.id, ...accountForm });
    } else {
      addAccount.mutate(accountForm);
    }
  };
  
  const handleEditAccount = (account: MailAccount) => {
    setEditingAccount(account);
    setAccountForm({
      email_address: account.email_address,
      display_name: account.display_name || '',
      provider: account.provider,
      username: '', // Don't pre-fill for security
      password: '',
      imap_host: '', // Would need to fetch from backend or store in state
      smtp_host: '',
      imap_port: 993,
      smtp_port: 587,
    });
    setIsAddAccountOpen(true);
  };
  
  const handleSendEmail = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccount) {
      toast({ title: 'Please select an account', variant: 'destructive' });
      return;
    }
    sendEmailMutation.mutate({
      account_id: selectedAccount,
      ...composeForm,
    });
  };

  const selectedAccountData = accounts.find(a => a.id === selectedAccount);

  return (
    <div className="flex h-[calc(100vh-0px)] overflow-hidden">
      {/* Sidebar */}
      <div className={`${isMobile ? 'w-64' : (sidebarCollapsed ? 'w-16' : 'w-64')} border-r border-border bg-card flex flex-col transition-all duration-200`}>
        {/* Compose Button */}
        <div className="p-4 flex items-center gap-2">
          {!isMobile && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </Button>
          )}
          <Button 
            className={`${isMobile ? 'w-full' : (sidebarCollapsed ? 'w-full px-2' : 'w-full')}`} 
            onClick={() => setIsComposeOpen(true)}
            title={sidebarCollapsed && !isMobile ? 'Compose' : undefined}
          >
            <PenSquare className={`h-4 w-4 ${(sidebarCollapsed && !isMobile) ? '' : 'mr-2'}`} />
            {(!sidebarCollapsed || isMobile) && 'Compose'}
          </Button>
        </div>

        {/* Folders */}
        <nav className="px-2 space-y-1">
          {folders.map((folder) => (
            <button
              key={folder.id}
              onClick={() => setSelectedFolder(folder.id)}
              className={`w-full flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg text-sm transition-colors ${
                selectedFolder === folder.id
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
              title={(sidebarCollapsed && !isMobile) ? folder.label : undefined}
            >
              <folder.icon className="h-4 w-4 shrink-0" />
              {(!sidebarCollapsed || isMobile) && <span>{folder.label}</span>}
            </button>
          ))}
        </nav>

        {/* Accounts */}
        <div className="flex-1 overflow-auto mt-6">
          <div className={`px-4 pb-2 flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'justify-between'}`}>
            {(!sidebarCollapsed || isMobile) && (
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Accounts
              </span>
            )}
            <Dialog open={isAddAccountOpen} onOpenChange={(open) => {
              setIsAddAccountOpen(open);
              if (!open) {
                setEditingAccount(null);
                setAccountForm({
                  email_address: '',
                  display_name: '',
                  provider: '',
                  username: '',
                  password: '',
                  imap_host: '',
                  smtp_host: '',
                  imap_port: 993,
                  smtp_port: 587,
                });
              }
            }}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className={`h-6 w-6 ${(sidebarCollapsed && !isMobile) ? 'mx-auto' : ''}`} title={(sidebarCollapsed && !isMobile) ? 'Add Account' : undefined}>
                  <Plus className="h-4 w-4" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{editingAccount ? 'Edit Mail Account' : 'Add Mail Account'}</DialogTitle>
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
                  <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input
                      id="username"
                      value={accountForm.username}
                      onChange={(e) => setAccountForm({ ...accountForm, username: e.target.value })}
                      placeholder={accountForm.provider === 'gmail' ? 'Usually your email' : 'IMAP/SMTP username'}
                      required
                    />
                    {(accountForm.provider === 'gmail' || accountForm.provider === 'yahoo') && (
                      <p className="text-xs text-muted-foreground">
                        {accountForm.provider === 'gmail' ? 'Use an App Password (not your regular password). Generate one at myaccount.google.com/apppasswords' : 'You may need an App Password for Yahoo Mail'}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password {editingAccount && '(leave blank to keep current)'}</Label>
                    <Input
                      id="password"
                      type="password"
                      value={accountForm.password}
                      onChange={(e) => setAccountForm({ ...accountForm, password: e.target.value })}
                      placeholder="Password or App Password"
                      required={!editingAccount}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Server details are filled from the provider; you can change any value.
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="imap_host">IMAP Server</Label>
                    <Input
                      id="imap_host"
                      value={accountForm.imap_host}
                      onChange={(e) => setAccountForm({ ...accountForm, imap_host: e.target.value })}
                      placeholder="e.g. imap.gmail.com"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="imap_port">IMAP Port</Label>
                    <Input
                      id="imap_port"
                      type="number"
                      value={accountForm.imap_port}
                      onChange={(e) => setAccountForm({ ...accountForm, imap_port: parseInt(e.target.value) || 993 })}
                      placeholder="993"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="smtp_host">SMTP Server</Label>
                    <Input
                      id="smtp_host"
                      value={accountForm.smtp_host}
                      onChange={(e) => setAccountForm({ ...accountForm, smtp_host: e.target.value })}
                      placeholder="e.g. smtp.gmail.com"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="smtp_port">SMTP Port</Label>
                    <Input
                      id="smtp_port"
                      type="number"
                      value={accountForm.smtp_port}
                      onChange={(e) => setAccountForm({ ...accountForm, smtp_port: parseInt(e.target.value) || 587 })}
                      placeholder="587"
                    />
                  </div>
                  <div className="flex justify-end gap-3 pt-2">
                    <Button type="button" variant="outline" onClick={() => setIsAddAccountOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={addAccount.isPending || updateAccount.isPending}>
                      {(addAccount.isPending || updateAccount.isPending) && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {editingAccount ? 'Save Changes' : 'Add Account'}
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
                <div key={account.id} className={`relative group ${(sidebarCollapsed && !isMobile) ? 'flex justify-center' : ''}`}>
                  <button
                    onClick={() => setSelectedAccount(account.id)}
                    className={`w-full flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg text-sm transition-colors ${
                      selectedAccount === account.id
                        ? 'bg-mail/10 text-mail font-medium'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                    title={(sidebarCollapsed && !isMobile) ? (account.display_name || account.email_address) : undefined}
                  >
                    <div className="w-8 h-8 rounded-full bg-mail/10 flex items-center justify-center text-mail text-xs font-medium shrink-0">
                      {account.email_address[0].toUpperCase()}
                    </div>
                    {(!sidebarCollapsed || isMobile) && (
                      <div className="flex-1 min-w-0 text-left">
                        <p className="truncate">{account.display_name || account.email_address}</p>
                        <p className="text-xs text-muted-foreground truncate">{account.email_address}</p>
                      </div>
                    )}
                  </button>
                  {(!sidebarCollapsed || isMobile) && (
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditAccount(account);
                        }}
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setAccountToDelete(account.id);
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="h-14 border-b border-border flex items-center justify-between px-4">
          <div className="flex items-center gap-2">
            {emails.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSelectAll}
                title={selectedEmails.size === emails.length ? 'Deselect all' : 'Select all'}
              >
                {selectedEmails.size === emails.length ? (
                  <CheckSquare className="h-4 w-4" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </Button>
            )}
            <h2 className="font-semibold capitalize">{selectedFolder}</h2>
            {selectedEmails.size > 0 && (
              <span className="text-sm text-muted-foreground">
                ({selectedEmails.size} selected)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedEmails.size > 0 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => bulkMarkRead.mutate({ emailIds: Array.from(selectedEmails), is_read: true })}
                  disabled={bulkMarkRead.isPending}
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Mark Read
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => bulkStar.mutate({ emailIds: Array.from(selectedEmails), is_starred: true })}
                  disabled={bulkStar.isPending}
                >
                  <Star className="h-4 w-4 mr-2" />
                  Star
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const folder = selectedFolder === 'inbox' ? 'archive' : 'inbox';
                    bulkMove.mutate({ emailIds: Array.from(selectedEmails), folder });
                  }}
                  disabled={bulkMove.isPending}
                >
                  <FolderOpen className="h-4 w-4 mr-2" />
                  Move
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => bulkDelete.mutate(Array.from(selectedEmails))}
                  disabled={bulkDelete.isPending}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </>
            )}
            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => selectedAccount && syncMail.mutate(selectedAccount)}
              disabled={!selectedAccount || syncMail.isPending}
              title="Refresh emails"
            >
              <RefreshCw className={`h-4 w-4 ${syncMail.isPending ? 'animate-spin' : ''}`} />
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
                    } ${selectedEmails.has(email.id) ? 'bg-accent/10 ring-2 ring-accent' : ''}`}
                    onClick={async (e) => {
                      // If clicking checkbox area, don't open email
                      if ((e.target as HTMLElement).closest('.email-checkbox')) {
                        return;
                      }
                      // Mark as read if unread
                      if (!email.is_read) {
                        markAsRead.mutate(email.id);
                      }
                      // Fetch full email and open reader
                      try {
                        const response = await api.get<{ email: Email }>(`/mail/emails/${email.id}`);
                        if (response.error) {
                          toast({ title: 'Failed to load email', description: response.error, variant: 'destructive' });
                          return;
                        }
                        if (response.data?.email) {
                          setSelectedEmail(response.data.email);
                        } else {
                          // Fallback: use the email from list if full fetch fails
                          setSelectedEmail(email);
                        }
                      } catch (error) {
                        console.error('Error loading email:', error);
                        // Fallback: use the email from list
                        setSelectedEmail(email);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenuEmail({ email, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <div className="email-checkbox shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => handleEmailSelect(email.id, e)}
                      >
                        {selectedEmails.has(email.id) ? (
                          <CheckSquare className="h-4 w-4 text-accent" />
                        ) : (
                          <Square className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
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
                        <div className="flex items-center gap-2 min-w-0">
                          {!email.is_read && (
                            <span className="h-2 w-2 rounded-full bg-accent shrink-0" />
                          )}
                          <span className={`font-medium truncate ${!email.is_read ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>
                            {email.from_name || email.from_address}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {format(new Date(email.received_at), 'MMM d')}
                        </span>
                      </div>
                      <p className={`truncate ${!email.is_read ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
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

      {/* Context Menu */}
      {contextMenuEmail && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenuEmail(null)}
          />
          <div
            className="fixed z-50 bg-popover border border-border rounded-md shadow-lg p-1 min-w-[200px]"
            style={{ left: contextMenuEmail.x, top: contextMenuEmail.y }}
          >
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
            onClick={() => {
              if (!contextMenuEmail.email.is_read) {
                markAsRead.mutate(contextMenuEmail.email.id);
              } else {
                bulkMarkRead.mutate({ emailIds: [contextMenuEmail.email.id], is_read: false });
              }
              setContextMenuEmail(null);
            }}
          >
            <CheckCircle2 className="h-4 w-4" />
            {contextMenuEmail.email.is_read ? 'Mark as Unread' : 'Mark as Read'}
          </button>
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
            onClick={() => {
              toggleStar.mutate({ id: contextMenuEmail.email.id, is_starred: !contextMenuEmail.email.is_starred });
              setContextMenuEmail(null);
            }}
          >
            <Star className={`h-4 w-4 ${contextMenuEmail.email.is_starred ? 'fill-warning text-warning' : ''}`} />
            {contextMenuEmail.email.is_starred ? 'Unstar' : 'Star'}
          </button>
          <div className="border-t border-border my-1" />
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
            onClick={() => {
              const targetFolder = selectedFolder === 'inbox' ? 'archive' : 'inbox';
              bulkMove.mutate({ emailIds: [contextMenuEmail.email.id], folder: targetFolder });
              setContextMenuEmail(null);
            }}
          >
            <FolderOpen className="h-4 w-4" />
            Move to {selectedFolder === 'inbox' ? 'Archive' : 'Inbox'}
          </button>
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2 text-destructive"
            onClick={() => {
              bulkDelete.mutate([contextMenuEmail.email.id]);
              setContextMenuEmail(null);
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
        </>
      )}

      {/* Delete Account Confirmation */}
      <AlertDialog open={!!accountToDelete} onOpenChange={(open) => !open && setAccountToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Mail Account?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the account and all associated emails from the database. 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => accountToDelete && deleteAccount.mutate(accountToDelete)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Email Reader */}
      {selectedEmail && (
        <div className="fixed inset-0 z-50 bg-background">
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="border-b border-border p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setSelectedEmail(null);
                    setIsReplying(false);
                    setComposeForm({ to: '', subject: '', body: '' });
                    setComposeMode('new');
                  }}
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setComposeMode('reply');
                      if (!selectedAccount) {
                        setSelectedAccount(selectedEmail.mail_account_id);
                      }
                      setComposeForm({
                        to: selectedEmail.from_address,
                        subject: `Re: ${selectedEmail.subject || ''}`,
                        body: `\n\n--- Original Message ---\nFrom: ${selectedEmail.from_name || selectedEmail.from_address}\nDate: ${format(new Date(selectedEmail.received_at), 'PPpp')}\n\n${selectedEmail.body_text || ''}`,
                      });
                      if (isMobile) {
                        setIsComposeOpen(true);
                      } else {
                        setIsReplying(true);
                      }
                    }}
                  >
                    <Reply className="h-4 w-4 mr-2" />
                    Reply
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setComposeMode('forward');
                      if (!selectedAccount) {
                        setSelectedAccount(selectedEmail.mail_account_id);
                      }
                      setComposeForm({
                        to: '',
                        subject: `Fwd: ${selectedEmail.subject || ''}`,
                        body: `\n\n--- Forwarded Message ---\nFrom: ${selectedEmail.from_name || selectedEmail.from_address}\nDate: ${format(new Date(selectedEmail.received_at), 'PPpp')}\n\n${selectedEmail.body_text || ''}`,
                      });
                      if (isMobile) {
                        setIsComposeOpen(true);
                      } else {
                        setIsReplying(true);
                      }
                    }}
                  >
                    <Forward className="h-4 w-4 mr-2" />
                    Forward
                  </Button>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => toggleStar.mutate({ id: selectedEmail.id, is_starred: !selectedEmail.is_starred })}
              >
                <Star className={`h-5 w-5 ${selectedEmail.is_starred ? 'fill-warning text-warning' : 'text-muted-foreground'}`} />
              </Button>
            </div>
            
            {/* Email Content */}
            <div className={`flex-1 overflow-auto p-6 ${!isMobile && isReplying ? 'pb-0' : ''}`}>
              <div className="max-w-4xl mx-auto space-y-4">
                <div>
                  <h1 className="text-2xl font-bold mb-4">{selectedEmail.subject || '(No subject)'}</h1>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <div>
                      <span className="font-medium text-foreground">From:</span> {selectedEmail.from_name ? `${selectedEmail.from_name} <${selectedEmail.from_address}>` : selectedEmail.from_address}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">To:</span> {selectedEmail.to_addresses?.join(', ') || 'N/A'}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Date:</span> {format(new Date(selectedEmail.received_at), 'PPpp')}
                    </div>
                  </div>
                </div>
                
                <div className="border-t border-border pt-4">
                  {selectedEmail.body_html ? (
                    <div 
                      className="prose prose-sm max-w-none dark:prose-invert prose-headings:text-foreground prose-p:text-foreground prose-a:text-accent prose-strong:text-foreground prose-code:text-foreground"
                      style={{
                        maxWidth: '100%',
                        wordBreak: 'break-word',
                      }}
                      dangerouslySetInnerHTML={{ __html: selectedEmail.body_html }}
                    />
                  ) : (
                    <div className="whitespace-pre-wrap text-foreground break-words">
                      {selectedEmail.body_text || '(No content)'}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Desktop: Inline Compose Editor */}
            {!isMobile && isReplying && (
              <div className="border-t border-border bg-card">
                <div className="p-4 max-w-4xl mx-auto">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold">
                      {composeMode === 'reply' ? 'Reply' : composeMode === 'forward' ? 'Forward' : 'Compose'}
                    </h2>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setIsReplying(false);
                        setComposeForm({ to: '', subject: '', body: '' });
                        setComposeMode('new');
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <form onSubmit={handleSendEmail} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="compose-to-inline">To</Label>
                      <Input 
                        id="compose-to-inline"
                        type="email"
                        placeholder="recipient@example.com"
                        value={composeForm.to}
                        onChange={(e) => setComposeForm({ ...composeForm, to: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="compose-subject-inline">Subject</Label>
                      <Input 
                        id="compose-subject-inline"
                        placeholder="Enter subject"
                        value={composeForm.subject}
                        onChange={(e) => setComposeForm({ ...composeForm, subject: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="compose-body-inline">Message</Label>
                      <Textarea 
                        id="compose-body-inline"
                        className="min-h-[300px]"
                        placeholder="Write your message..."
                        value={composeForm.body}
                        onChange={(e) => setComposeForm({ ...composeForm, body: e.target.value })}
                        required
                      />
                    </div>
                    <div className="flex justify-end gap-3">
                      <Button 
                        type="button" 
                        variant="outline" 
                        onClick={() => {
                          setIsReplying(false);
                          setComposeForm({ to: '', subject: '', body: '' });
                          setComposeMode('new');
                        }}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={sendEmailMutation.isPending}>
                        {sendEmailMutation.isPending ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Sending...
                          </>
                        ) : (
                          <>
                            <Send className="h-4 w-4 mr-2" />
                            Send
                          </>
                        )}
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Compose Dialog - Mobile or New Message */}
      <Dialog open={isComposeOpen} onOpenChange={(open) => {
        setIsComposeOpen(open);
        if (!open) {
          setComposeMode('new');
          setComposeForm({ to: '', subject: '', body: '' });
          setIsReplying(false);
        }
      }}>
        <DialogContent className={`${isMobile ? 'max-w-full h-[95vh] max-h-[95vh] flex flex-col p-4 translate-y-[-47.5%] top-[47.5%] rounded-t-lg rounded-b-none' : 'sm:max-w-2xl'}`}>
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {composeMode === 'reply' ? 'Reply' : composeMode === 'forward' ? 'Forward' : 'New Message'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSendEmail} className={`space-y-4 mt-4 ${isMobile ? 'flex-1 flex flex-col min-h-0 overflow-hidden' : ''}`}>
            <div className={`space-y-4 ${isMobile ? 'shrink-0' : ''}`}>
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
                <Label htmlFor="compose-to">To</Label>
                <Input 
                  id="compose-to"
                  type="email"
                  placeholder="recipient@example.com"
                  value={composeForm.to}
                  onChange={(e) => setComposeForm({ ...composeForm, to: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="compose-subject">Subject</Label>
                <Input 
                  id="compose-subject"
                  placeholder="Enter subject"
                  value={composeForm.subject}
                  onChange={(e) => setComposeForm({ ...composeForm, subject: e.target.value })}
                  required
                />
              </div>
            </div>
            <div className={`space-y-2 ${isMobile ? 'flex-1 flex flex-col min-h-0' : ''}`}>
              <Label htmlFor="compose-body">Message</Label>
              <Textarea 
                id="compose-body"
                className={`${isMobile ? 'flex-1 min-h-[200px] resize-none' : 'min-h-[200px]'}`}
                placeholder="Write your message..."
                value={composeForm.body}
                onChange={(e) => setComposeForm({ ...composeForm, body: e.target.value })}
                required
              />
            </div>
            <div className={`flex justify-end gap-3 ${isMobile ? 'shrink-0 pt-4 border-t border-border' : ''}`}>
              <Button type="button" variant="outline" onClick={() => {
                setIsComposeOpen(false);
                setComposeMode('new');
                setComposeForm({ to: '', subject: '', body: '' });
                setIsReplying(false);
              }}>
                Cancel
              </Button>
              <Button type="submit" disabled={sendEmailMutation.isPending}>
                {sendEmailMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Send
                  </>
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default MailPage;
