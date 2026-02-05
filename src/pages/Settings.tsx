import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { User, Shield, Bell, Palette, Download, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

const Settings = () => {
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [fullName, setFullName] = useState(user?.full_name || '');
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
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
      // Note: Profile update endpoint would need to be added to API
      // For now, this is a placeholder
      toast({ title: 'Profile update coming soon', description: 'This feature will be available in the next update' });
    } catch (error: any) {
      toast({ title: 'Failed to update profile', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const sections = [
    {
      id: 'profile',
      title: 'Profile',
      description: 'Manage your account details',
      icon: User,
    },
    {
      id: 'security',
      title: 'Security',
      description: 'Password and authentication',
      icon: Shield,
    },
    {
      id: 'notifications',
      title: 'Notifications',
      description: 'Configure how you receive alerts',
      icon: Bell,
    },
    {
      id: 'appearance',
      title: 'Appearance',
      description: 'Customize the look and feel',
      icon: Palette,
    },
    {
      id: 'data',
      title: 'Data & Export',
      description: 'Download or delete your data',
      icon: Download,
    },
  ];

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
