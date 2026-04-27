import { useState, useEffect, type ChangeEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { calendarQueryKeys } from '@/lib/calendar-api';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
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
import { User, Shield, Download, Loader2, Database, Globe, AtSign, Upload } from 'lucide-react';
import { motion } from 'framer-motion';

const DEVICE_TZ_VALUE = '';
const timezoneOptions = (() => {
  try {
    const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
    return [DEVICE_TZ_VALUE, ...zones.sort()];
  } catch {
    return [DEVICE_TZ_VALUE];
  }
})();

type MailSenderRule = {
  id: string;
  user_id: string;
  mail_account_id: string | null;
  match_type: 'domain' | 'email';
  match_value: string;
  target_folder: string;
  priority: number;
  is_active: number | boolean;
  created_at?: string;
  updated_at?: string;
  account_email?: string | null;
};

type MailCandidateDomain = {
  domain: string;
  email_count: number;
  last_received_at: string | null;
  has_rule: number;
  matching_rule?: MailSenderRule | null;
};

type MailCandidateSender = {
  sender_email: string;
  sender_name: string | null;
  email_count: number;
  last_received_at: string | null;
  has_rule: number;
  matching_rule?: MailSenderRule | null;
};

type MailFolder = {
  slug: string;
  display_name: string;
  is_system: boolean;
};

type BackupImportResult = {
  dry_run?: boolean;
  valid?: boolean;
  errors?: string[];
  warnings?: string[];
  counts?: Record<string, number>;
  restored_files?: number;
};

const FALLBACK_MAIL_FOLDERS: MailFolder[] = [
  { slug: 'inbox', display_name: 'Inbox', is_system: true },
  { slug: 'important', display_name: 'Important', is_system: true },
  { slug: 'marketing', display_name: 'Marketing', is_system: true },
  { slug: 'twofactor_notifications', display_name: '2FA / Notifications', is_system: true },
  { slug: 'archive', display_name: 'Archive', is_system: true },
  { slug: 'unknown', display_name: 'Unknown', is_system: true },
  { slug: 'scam', display_name: 'Scam', is_system: true },
  { slug: 'trash', display_name: 'Trash', is_system: true },
];

const Settings = () => {
  const { user, setUser, signOut } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [fullName, setFullName] = useState(user?.full_name || '');
  const [timezone, setTimezone] = useState(user?.timezone ?? DEVICE_TZ_VALUE);
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [clearContactsOpen, setClearContactsOpen] = useState(false);
  const [clearCalendarOpen, setClearCalendarOpen] = useState(false);
  const [clearMailOpen, setClearMailOpen] = useState(false);
  const [clearContactsLoading, setClearContactsLoading] = useState(false);
  const [clearCalendarLoading, setClearCalendarLoading] = useState(false);
  const [clearMailLoading, setClearMailLoading] = useState(false);
  const [ruleSaving, setRuleSaving] = useState(false);
  const [ruleEditorOpen, setRuleEditorOpen] = useState(false);
  const [backupExporting, setBackupExporting] = useState(false);
  const [backupImporting, setBackupImporting] = useState(false);
  const [backupApplying, setBackupApplying] = useState(false);
  const [pendingBackup, setPendingBackup] = useState<Record<string, unknown> | null>(null);
  const [backupPlan, setBackupPlan] = useState<BackupImportResult | null>(null);
  const [ruleEditor, setRuleEditor] = useState<{
    id?: string;
    match_type: 'domain' | 'email';
    match_value: string;
    target_folder: string;
    mail_account_id: string;
    priority: number;
    is_active: boolean;
  }>({
    match_type: 'domain',
    match_value: '',
    target_folder: 'marketing',
    mail_account_id: '',
    priority: 100,
    is_active: true,
  });

  const { data: mailSenderCandidates, isLoading: mailSenderCandidatesLoading, refetch: refetchMailSenderCandidates } = useQuery({
    queryKey: ['mail-sender-candidates'],
    queryFn: async () => {
      const response = await api.get<{
        domains: MailCandidateDomain[];
        senders: MailCandidateSender[];
      }>('/settings/mail-sender-candidates?domain_limit=20&sender_limit=20');
      if (response.error) throw new Error(response.error);
      return response.data ?? { domains: [], senders: [] };
    },
  });

  const { data: mailAccounts } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: async () => {
      const response = await api.get<{ accounts: Array<{ id: string; email_address: string; display_name?: string | null }> }>('/mail/accounts');
      if (response.error) throw new Error(response.error);
      return response.data?.accounts ?? [];
    },
  });

  const { data: mailFolders = FALLBACK_MAIL_FOLDERS } = useQuery({
    queryKey: ['mail-folders'],
    queryFn: async () => {
      const response = await api.get<{ folders: MailFolder[] }>('/mail/folders');
      if (response.error) throw new Error(response.error);
      return response.data?.folders ?? FALLBACK_MAIL_FOLDERS;
    },
  });

  const getMailFolderLabel = (slug: string) =>
    (mailFolders.length ? mailFolders : FALLBACK_MAIL_FOLDERS).find((folder) => folder.slug === slug)?.display_name || slug;

  useEffect(() => {
    setFullName(user?.full_name || '');
    setTimezone(user?.timezone ?? DEVICE_TZ_VALUE);
  }, [user?.full_name, user?.timezone]);

  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: '',
  });
  const [passwordLoading, setPasswordLoading] = useState(false);

  const handleChangePassword = async () => {
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      toast({ title: 'Passwords do not match', variant: 'destructive' });
      return;
    }
    if (passwordForm.new_password.length < 12) {
      toast({ title: 'New password must be at least 12 characters', variant: 'destructive' });
      return;
    }
    setPasswordLoading(true);
    try {
      const response = await api.put('/auth/password', {
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password,
      });
      if (response.error) {
        toast({ title: 'Failed to change password', description: response.error, variant: 'destructive' });
      } else {
        toast({ title: 'Password changed successfully' });
        setIsPasswordOpen(false);
        setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to change password', description: message, variant: 'destructive' });
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleUpdateProfile = async () => {
    setLoading(true);
    try {
      const response = await api.put<{ user: { id: string; email: string; full_name?: string; avatar_url?: string; role?: string; timezone?: string | null } }>('/auth/profile', {
        full_name: fullName.trim(),
        timezone: timezone === DEVICE_TZ_VALUE ? null : timezone,
      });
      if (response.error) {
        toast({ title: 'Failed to update profile', description: response.error, variant: 'destructive' });
      } else {
        if (response.data?.user) setUser(response.data.user);
        toast({ title: 'Profile updated successfully' });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to update profile', description: message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleClearContacts = async () => {
    setClearContactsLoading(true);
    try {
      const response = await api.post<{ message?: string; error?: string; deleted?: number }>('/settings/clear-contacts');
      if (response.error) {
        toast({ title: 'Failed to delete contacts', description: response.error, variant: 'destructive' });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-count'] });
      toast({ title: response.data?.message || 'All contacts deleted' });
      setClearContactsOpen(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to delete contacts', description: message, variant: 'destructive' });
    } finally {
      setClearContactsLoading(false);
    }
  };

  const handleClearCalendar = async () => {
    setClearCalendarLoading(true);
    try {
      const response = await api.post<{ message?: string; error?: string; deleted?: number }>('/settings/clear-calendar');
      if (response.error) {
        toast({ title: 'Failed to delete calendar and todo data', description: response.error, variant: 'destructive' });
        return;
      }
      queryClient.invalidateQueries({ queryKey: calendarQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: calendarQueryKeys.upcomingEvents });
      queryClient.invalidateQueries({ queryKey: calendarQueryKeys.stats });
      toast({ title: response.data?.message || 'All calendar and todo entries deleted' });
      setClearCalendarOpen(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to delete calendar and todo data', description: message, variant: 'destructive' });
    } finally {
      setClearCalendarLoading(false);
    }
  };

  const handleClearMail = async () => {
    setClearMailLoading(true);
    try {
      const response = await api.post<{ message?: string; error?: string; deleted?: number }>('/settings/clear-mail-accounts');
      if (response.error) {
        toast({ title: 'Failed to delete mail accounts', description: response.error, variant: 'destructive' });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts-count'] });
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['mail-sender-candidates'] });
      toast({ title: response.data?.message || 'All mail accounts deleted' });
      setClearMailOpen(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to delete mail accounts', description: message, variant: 'destructive' });
    } finally {
      setClearMailLoading(false);
    }
  };

  const handleExportBackup = async () => {
    setBackupExporting(true);
    try {
      const { blob, filename } = await api.getBlob('/backup/export');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || `unihub-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Backup exported' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to export backup', description: message, variant: 'destructive' });
    } finally {
      setBackupExporting(false);
    }
  };

  const handleBackupImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setBackupImporting(true);
    try {
      const parsedBackup = JSON.parse(await file.text()) as Record<string, unknown>;
      const response = await api.post<{ import: BackupImportResult }>('/backup/import', {
        mode: 'dry-run',
        backup: parsedBackup,
      });
      if (response.error) {
        toast({ title: 'Backup validation failed', description: response.error, variant: 'destructive' });
        return;
      }
      const result = response.data?.import || null;
      setPendingBackup(parsedBackup);
      setBackupPlan(result);
      toast({
        title: result?.valid ? 'Backup is ready to import' : 'Backup validation failed',
        description: result?.valid ? 'Review the counts and apply when ready.' : result?.errors?.join(' '),
        variant: result?.valid ? undefined : 'destructive',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Invalid backup file';
      toast({ title: 'Failed to read backup', description: message, variant: 'destructive' });
      setPendingBackup(null);
      setBackupPlan(null);
    } finally {
      setBackupImporting(false);
    }
  };

  const handleApplyBackupImport = async () => {
    if (!pendingBackup) return;
    setBackupApplying(true);
    try {
      const response = await api.post<{ import: BackupImportResult }>('/backup/import', {
        mode: 'apply',
        backup: pendingBackup,
      });
      if (response.error) {
        toast({ title: 'Backup import failed', description: response.error, variant: 'destructive' });
        return;
      }
      setBackupPlan(response.data?.import || null);
      setPendingBackup(null);
      await queryClient.invalidateQueries();
      toast({ title: 'Backup imported', description: `${response.data?.import?.restored_files || 0} files restored.` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Backup import failed', description: message, variant: 'destructive' });
    } finally {
      setBackupApplying(false);
    }
  };

  const formatCandidateDate = (value: string | null) => {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return date.toLocaleDateString();
  };

  const formatRuleDetails = (rule?: MailSenderRule | null) => {
    if (!rule) return 'No rule yet';
    const scope = rule.mail_account_id ? `Account: ${rule.account_email || rule.mail_account_id}` : 'All accounts';
    return `Folder: ${getMailFolderLabel(rule.target_folder)} • ${scope} • Priority: ${rule.priority} • ${rule.is_active ? 'Active' : 'Inactive'}`;
  };

  const openCreateRuleEditor = (candidate: { match_type: 'domain' | 'email'; match_value: string; matching_rule?: MailSenderRule | null }) => {
    const existing = candidate.matching_rule || null;
    setRuleEditor({
      id: existing?.id,
      match_type: candidate.match_type,
      match_value: candidate.match_value,
      target_folder: existing?.target_folder || 'marketing',
      mail_account_id: existing?.mail_account_id || '',
      priority: typeof existing?.priority === 'number' ? existing.priority : 100,
      is_active: existing ? !!existing.is_active : true,
    });
    setRuleEditorOpen(true);
  };

  const saveRule = async () => {
    setRuleSaving(true);
    try {
      const payload = {
        match_type: ruleEditor.match_type,
        match_value: ruleEditor.match_value,
        target_folder: ruleEditor.target_folder,
        mail_account_id: ruleEditor.mail_account_id || null,
        priority: Number(ruleEditor.priority),
        is_active: ruleEditor.is_active,
      };
      const response = ruleEditor.id
        ? await api.put(`/mail/sender-rules/${ruleEditor.id}`, payload)
        : await api.post('/mail/sender-rules', payload);
      if (response.error) {
        toast({ title: 'Failed to save rule', description: response.error, variant: 'destructive' });
        return;
      }
      toast({ title: ruleEditor.id ? 'Rule updated' : 'Rule created' });
      setRuleEditorOpen(false);
      await refetchMailSenderCandidates();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to save rule', description: message, variant: 'destructive' });
    } finally {
      setRuleSaving(false);
    }
  };

  const deleteRule = async () => {
    if (!ruleEditor.id) return;
    setRuleSaving(true);
    try {
      const response = await api.delete(`/mail/sender-rules/${ruleEditor.id}`);
      if (response.error) {
        toast({ title: 'Failed to delete rule', description: response.error, variant: 'destructive' });
        return;
      }
      toast({ title: 'Rule deleted' });
      setRuleEditorOpen(false);
      await refetchMailSenderCandidates();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to delete rule', description: message, variant: 'destructive' });
    } finally {
      setRuleSaving(false);
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mb-8"
      >
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </motion.div>

      <div className="space-y-6">
        {/* Profile Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <User className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Profile</CardTitle>
                  <CardDescription>Manage your account details</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={user?.email || ''} disabled />
                <p className="text-xs text-muted-foreground">
                  Your email cannot be changed
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fullName">Full Name</Label>
                <Input
                  id="fullName"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Enter your name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="timezone">Time zone</Label>
                <select
                  id="timezone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value={DEVICE_TZ_VALUE}>Use device time zone</option>
                  {timezoneOptions.filter((z) => z !== DEVICE_TZ_VALUE).map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Used for calendar and to-do dates and times
                </p>
              </div>
              <Button onClick={handleUpdateProfile} disabled={loading}>
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        {/* Security Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <Shield className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Security</CardTitle>
                  <CardDescription>Password and authentication settings</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-foreground">Password</p>
                  <p className="text-sm text-muted-foreground">Change your account password</p>
                </div>
                <Dialog open={isPasswordOpen} onOpenChange={(open) => {
                  setIsPasswordOpen(open);
                  if (!open) setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
                }}>
                  <DialogTrigger asChild>
                    <Button variant="outline">Change Password</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Change Password</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 pt-2">
                      <div className="space-y-2">
                        <Label htmlFor="currentPassword">Current Password</Label>
                        <Input
                          id="currentPassword"
                          type="password"
                          value={passwordForm.current_password}
                          onChange={(e) => setPasswordForm(f => ({ ...f, current_password: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="newPassword">New Password</Label>
                        <Input
                          id="newPassword"
                          type="password"
                          value={passwordForm.new_password}
                          onChange={(e) => setPasswordForm(f => ({ ...f, new_password: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="confirmPassword">Confirm New Password</Label>
                        <Input
                          id="confirmPassword"
                          type="password"
                          value={passwordForm.confirm_password}
                          onChange={(e) => setPasswordForm(f => ({ ...f, confirm_password: e.target.value }))}
                        />
                      </div>
                      <div className="flex justify-end gap-2 pt-2">
                        <Button variant="outline" onClick={() => setIsPasswordOpen(false)}>
                          Cancel
                        </Button>
                        <Button onClick={handleChangePassword} disabled={passwordLoading}>
                          {passwordLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                          Update Password
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-foreground">Two-Factor Authentication</p>
                  <p className="text-sm text-muted-foreground">Add an extra layer of security</p>
                </div>
                <Button variant="outline" disabled>Coming Soon</Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* App Info */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
        >
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <Download className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Install App</CardTitle>
                  <CardDescription>UniHub works as a Progressive Web App</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                Install UniHub on your device for quick access. On mobile, use your browser's "Add to Home Screen" option.
                On desktop, look for the install icon in your browser's address bar.
              </p>
              <Button variant="outline" asChild>
                <a href="/install">Learn How to Install</a>
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        {/* Backup and restore */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.33 }}
        >
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <Database className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Backup and restore</CardTitle>
                  <CardDescription>Export everything first, then validate imports before applying them.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={handleExportBackup} disabled={backupExporting}>
                  {backupExporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                  Export backup
                </Button>
                <input
                  id="backup-import-file"
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleBackupImportFile}
                />
                <Button
                  variant="outline"
                  onClick={() => document.getElementById('backup-import-file')?.click()}
                  disabled={backupImporting}
                >
                  {backupImporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                  Validate import
                </Button>
                <Button
                  onClick={handleApplyBackupImport}
                  disabled={!pendingBackup || !backupPlan?.valid || backupApplying}
                >
                  {backupApplying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Apply validated import
                </Button>
              </div>

              {backupPlan && (
                <div className="rounded-md border border-border p-3 text-sm space-y-2">
                  <p className="font-medium text-foreground">
                    {backupPlan.valid ? 'Validated backup contents' : 'Backup validation errors'}
                  </p>
                  {backupPlan.counts && (
                    <div className="grid gap-1 sm:grid-cols-2">
                      {Object.entries(backupPlan.counts).map(([key, value]) => (
                        <p key={key} className="text-muted-foreground">
                          {key.replace(/_/g, ' ')}: <span className="text-foreground">{value}</span>
                        </p>
                      ))}
                    </div>
                  )}
                  {(backupPlan.errors?.length || 0) > 0 && (
                    <ul className="list-disc pl-5 text-destructive">
                      {backupPlan.errors?.map((error) => <li key={error}>{error}</li>)}
                    </ul>
                  )}
                  {(backupPlan.warnings?.length || 0) > 0 && (
                    <ul className="list-disc pl-5 text-muted-foreground">
                      {backupPlan.warnings?.map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Data management */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.35 }}
        >
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <Database className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Data management</CardTitle>
                  <CardDescription>Permanently clear your data. These actions cannot be undone.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-foreground">Delete all Contacts</p>
                  <p className="text-sm text-muted-foreground">Remove every contact from your account</p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setClearContactsOpen(true)}
                >
                  Delete all Contacts
                </Button>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-foreground">Delete all Calendar & ToDo</p>
                  <p className="text-sm text-muted-foreground">Remove all events and todo entries</p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setClearCalendarOpen(true)}
                >
                  Delete all Calendar/ToDo
                </Button>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-foreground">Delete all Mail Accounts</p>
                  <p className="text-sm text-muted-foreground">Remove all mail accounts and their emails</p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setClearMailOpen(true)}
                >
                  Delete all Mail Accounts
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Mail categorization foundation */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.38 }}
        >
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-accent/10">
                    <AtSign className="h-5 w-5 text-accent" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Mail categorization foundation</CardTitle>
                    <CardDescription>
                      Create and manage sender/domain routing rules used by inbound mail sync.
                    </CardDescription>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => refetchMailSenderCandidates()} disabled={mailSenderCandidatesLoading}>
                  {mailSenderCandidatesLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <p className="font-medium text-foreground">Top domains</p>
                </div>
                {mailSenderCandidatesLoading ? (
                  <p className="text-sm text-muted-foreground">Loading domains...</p>
                ) : (mailSenderCandidates?.domains?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No domains found yet. Sync some emails first.</p>
                ) : (
                  <div className="space-y-2">
                    {mailSenderCandidates?.domains.map((domain) => (
                      <div key={domain.domain} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                        <div>
                          <p className="font-medium text-foreground">{domain.domain}</p>
                          <p className="text-xs text-muted-foreground">Last seen: {formatCandidateDate(domain.last_received_at)}</p>
                          <p className="text-xs text-muted-foreground">{formatRuleDetails(domain.matching_rule)}</p>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <div>
                          <p className="text-sm text-foreground">{domain.email_count} emails</p>
                            <p className="text-xs text-muted-foreground">{domain.has_rule ? 'Rule configured' : 'No rule yet'}</p>
                          </div>
                          <Button
                            size="sm"
                            variant={domain.matching_rule ? 'secondary' : 'outline'}
                            onClick={() => openCreateRuleEditor({ match_type: 'domain', match_value: domain.domain, matching_rule: domain.matching_rule })}
                          >
                            Create rule
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <Separator />
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <AtSign className="h-4 w-4 text-muted-foreground" />
                  <p className="font-medium text-foreground">Top senders</p>
                </div>
                {mailSenderCandidatesLoading ? (
                  <p className="text-sm text-muted-foreground">Loading senders...</p>
                ) : (mailSenderCandidates?.senders?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No senders found yet. Sync some emails first.</p>
                ) : (
                  <div className="space-y-2">
                    {mailSenderCandidates?.senders.map((sender) => (
                      <div key={sender.sender_email} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                        <div>
                          <p className="font-medium text-foreground">{sender.sender_name || sender.sender_email}</p>
                          <p className="text-xs text-muted-foreground">{sender.sender_email}</p>
                          <p className="text-xs text-muted-foreground">{formatRuleDetails(sender.matching_rule)}</p>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <div>
                          <p className="text-sm text-foreground">{sender.email_count} emails</p>
                            <p className="text-xs text-muted-foreground">{sender.has_rule ? 'Rule configured' : 'No rule yet'}</p>
                          </div>
                          <Button
                            size="sm"
                            variant={sender.matching_rule ? 'secondary' : 'outline'}
                            onClick={() => openCreateRuleEditor({ match_type: 'email', match_value: sender.sender_email, matching_rule: sender.matching_rule })}
                          >
                            Create rule
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {ruleEditorOpen && (
                <>
                  <Separator />
                  <div className="rounded-md border border-border p-4 space-y-3">
                    <p className="font-medium text-foreground">{ruleEditor.id ? 'Edit sender rule' : 'Create sender rule'}</p>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1">
                        <Label>Match type</Label>
                        <Input value={ruleEditor.match_type} disabled />
                      </div>
                      <div className="space-y-1">
                        <Label>Match value</Label>
                        <Input value={ruleEditor.match_value} disabled />
                      </div>
                      <div className="space-y-1">
                        <Label>Target folder</Label>
                        <select
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          value={ruleEditor.target_folder}
                          onChange={(e) => setRuleEditor((prev) => ({ ...prev, target_folder: e.target.value }))}
                        >
                          {(mailFolders.length ? mailFolders : FALLBACK_MAIL_FOLDERS).map((folder) => (
                            <option key={folder.slug} value={folder.slug}>{folder.display_name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label>Account scope (optional)</Label>
                        <select
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          value={ruleEditor.mail_account_id}
                          onChange={(e) => setRuleEditor((prev) => ({ ...prev, mail_account_id: e.target.value }))}
                        >
                          <option value="">All accounts</option>
                          {(mailAccounts || []).map((account) => (
                            <option key={account.id} value={account.id}>{account.display_name || account.email_address}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label>Priority (lower wins)</Label>
                        <Input
                          type="number"
                          value={ruleEditor.priority}
                          onChange={(e) => setRuleEditor((prev) => ({ ...prev, priority: Number.parseInt(e.target.value || '100', 10) || 100 }))}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Active</Label>
                        <div className="h-10 flex items-center">
                          <Switch
                            checked={ruleEditor.is_active}
                            onCheckedChange={(checked) => setRuleEditor((prev) => ({ ...prev, is_active: !!checked }))}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      {ruleEditor.id && (
                        <Button variant="destructive" onClick={deleteRule} disabled={ruleSaving}>
                          Delete
                        </Button>
                      )}
                      <Button variant="outline" onClick={() => setRuleEditorOpen(false)} disabled={ruleSaving}>
                        Cancel
                      </Button>
                      <Button onClick={saveRule} disabled={ruleSaving}>
                        {ruleSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {ruleEditor.id ? 'Update rule' : 'Create rule'}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </motion.div>

        <AlertDialog open={clearContactsOpen} onOpenChange={setClearContactsOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete all contacts?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete all your contacts and cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleClearContacts();
                }}
                disabled={clearContactsLoading}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {clearContactsLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Delete all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={clearCalendarOpen} onOpenChange={setClearCalendarOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete all calendar and todo entries?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete all your calendar events and todo items and cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleClearCalendar();
                }}
                disabled={clearCalendarLoading}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {clearCalendarLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Delete all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={clearMailOpen} onOpenChange={setClearMailOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete all mail accounts?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete all your mail accounts and their emails and cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleClearMail();
                }}
                disabled={clearMailLoading}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {clearMailLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Delete all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Danger Zone */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4 }}
        >
          <Card className="border-destructive/30">
            <CardHeader>
              <CardTitle className="text-lg text-destructive">Danger Zone</CardTitle>
              <CardDescription>Irreversible actions</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-foreground">Sign Out</p>
                  <p className="text-sm text-muted-foreground">Sign out of your account on this device</p>
                </div>
                <Button variant="outline" onClick={signOut}>Sign Out</Button>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-destructive">Delete Account</p>
                  <p className="text-sm text-muted-foreground">Permanently delete your account and all data</p>
                </div>
                <Button variant="destructive" disabled>Delete Account</Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
};

export default Settings;
