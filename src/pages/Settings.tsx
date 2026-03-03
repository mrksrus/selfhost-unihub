import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { User, Shield, Download, Loader2, Database } from 'lucide-react';
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
    if (passwordForm.new_password.length < 6) {
      toast({ title: 'New password must be at least 6 characters', variant: 'destructive' });
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
    } catch (error: any) {
      toast({ title: 'Failed to change password', description: error.message, variant: 'destructive' });
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
    } catch (error: any) {
      toast({ title: 'Failed to update profile', description: error.message, variant: 'destructive' });
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
    } catch (error: any) {
      toast({ title: 'Failed to delete contacts', description: error.message, variant: 'destructive' });
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
    } catch (error: any) {
      toast({ title: 'Failed to delete calendar and todo data', description: error.message, variant: 'destructive' });
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
      toast({ title: response.data?.message || 'All mail accounts deleted' });
      setClearMailOpen(false);
    } catch (error: any) {
      toast({ title: 'Failed to delete mail accounts', description: error.message, variant: 'destructive' });
    } finally {
      setClearMailLoading(false);
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
