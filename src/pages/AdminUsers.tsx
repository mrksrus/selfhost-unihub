import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { Shield, Key, Trash2, Loader2, UserCheck, UserX, UserCog, ShieldOff } from 'lucide-react';
import { motion } from 'framer-motion';

interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: 'user' | 'admin';
  is_active: boolean;
  two_factor_enabled?: boolean;
  created_at: string;
}

const AdminUsers = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [passwordDialogUser, setPasswordDialogUser] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [resetTwoFactorUser, setResetTwoFactorUser] = useState<UserRow | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  // The user the reset dialog shows now, read when a request completes.
  const openResetUserId = useRef<string | null>(null);
  useEffect(() => { openResetUserId.current = resetTwoFactorUser?.id ?? null; }, [resetTwoFactorUser]);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: async () => {
      const response = await api.get<{ users: UserRow[] }>('/admin/users');
      if (response.error) throw new Error(response.error);
      return response.data!.users;
    },
    enabled: user?.role === 'admin',
  });
  
  const deleteUser = useMutation({
    mutationFn: async (userId: string) => {
      const response = await api.delete(`/admin/users/${userId}`);
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast({ title: 'User deleted' });
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to delete user', description: err.message, variant: 'destructive' });
    },
  });

  const updateUserRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: 'user' | 'admin' }) => {
      const response = await api.put(`/admin/users/${userId}/role`, { role });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast({ title: variables.role === 'admin' ? 'User promoted to admin' : 'User changed to standard user' });
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to update role', description: err.message, variant: 'destructive' });
    },
  });
  
  const toggleUserActive = useMutation({
    mutationFn: async ({ userId, is_active }: { userId: string; is_active: boolean }) => {
      const response = await api.put(`/admin/users/${userId}/activate`, { is_active });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast({ title: variables.is_active ? 'User activated' : 'User deactivated' });
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to update user status', description: err.message, variant: 'destructive' });
    },
  });
  
  const resetTwoFactor = useMutation({
    mutationFn: async ({ user, currentPassword }: { user: UserRow; currentPassword: string }) => {
      const response = await api.post(`/admin/users/${user.id}/2fa/reset`, { current_password: currentPassword });
      if (response.error) throw new Error(response.error);
    },
    // Report on the submitted user; the dialog may have been reopened for someone else meanwhile.
    onSuccess: (_data, { user }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast({ title: `Two-factor authentication reset for ${user.email}`, description: 'They were signed out and can sign in with their password.' });
      if (openResetUserId.current === user.id) {
        setResetTwoFactorUser(null);
        setAdminPassword('');
      }
    },
    onError: (err: Error, { user }) => {
      toast({ title: `Failed to reset two-factor authentication for ${user.email}`, description: err.message, variant: 'destructive' });
    },
  });

  const handleChangePassword = async () => {
    if (!passwordDialogUser || !newPassword || newPassword.length < 12) {
      toast({ title: 'New password must be at least 12 characters', variant: 'destructive' });
      return;
    }
    setPasswordLoading(true);
    try {
      const response = await api.put(`/admin/users/${passwordDialogUser.id}/password`, {
        new_password: newPassword,
      });
      if (response.error) {
        toast({ title: 'Failed to change password', description: response.error, variant: 'destructive' });
      } else {
        toast({ title: `Password updated for ${passwordDialogUser.email}` });
        setPasswordDialogUser(null);
        setNewPassword('');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      toast({ title: 'Failed to change password', description: message, variant: 'destructive' });
    } finally {
      setPasswordLoading(false);
    }
  };

  if (user?.role !== 'admin') {
    return (
      <div className="p-6 lg:p-8 max-w-4xl mx-auto">
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">You do not have permission to view this page.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mb-8"
      >
        <h1 className="text-2xl font-bold text-foreground">User Management</h1>
        <p className="text-muted-foreground">Manage accounts and reset passwords</p>
      </motion.div>

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
                <CardTitle className="text-lg">All Users</CardTitle>
                <CardDescription>{data?.length || 0} registered users</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <LoadingState label="Loading users…" />
            ) : error ? (
              <ErrorState
                title="Could not load users"
                error={error}
                onRetry={() => void refetch()}
                retrying={isFetching}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.full_name || '\u2014'}</TableCell>
                      <TableCell>{u.email}</TableCell>
                      <TableCell>
                        <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>
                          {u.role}
                        </Badge>
                        {u.two_factor_enabled && <Badge variant="outline" className="ml-1">2FA</Badge>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.is_active ? 'default' : 'secondary'} className={u.is_active ? 'bg-success' : 'bg-muted'}>
                          {u.is_active ? 'Active' : 'Pending'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(u.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        {!u.is_active && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => toggleUserActive.mutate({ userId: u.id, is_active: true })}
                            disabled={toggleUserActive.isPending}
                            className="text-success hover:text-success"
                          >
                            <UserCheck className="h-3.5 w-3.5 mr-1" />
                            Approve
                          </Button>
                        )}
                        {u.is_active && u.id !== user?.id && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => toggleUserActive.mutate({ userId: u.id, is_active: false })}
                            disabled={toggleUserActive.isPending}
                            className="text-warning hover:text-warning"
                          >
                            <UserX className="h-3.5 w-3.5 mr-1" />
                            Deactivate
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => updateUserRole.mutate({ userId: u.id, role: u.role === 'admin' ? 'user' : 'admin' })}
                          disabled={updateUserRole.isPending}
                        >
                          <UserCog className="h-3.5 w-3.5 mr-1" />
                          {u.role === 'admin' ? 'Make user' : 'Make admin'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => { setPasswordDialogUser(u); setNewPassword(''); }}
                        >
                          <Key className="h-3.5 w-3.5 mr-1" />
                          Password
                        </Button>
                        {u.two_factor_enabled && u.id !== user?.id && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { setResetTwoFactorUser(u); setAdminPassword(''); }}
                          >
                            <ShieldOff className="h-3.5 w-3.5 mr-1" />
                            Reset 2FA
                          </Button>
                        )}
                        {u.id !== user?.id && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
                                <Trash2 className="h-3.5 w-3.5 mr-1" />
                                Delete
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete user?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently delete {u.email} and all of their data. This action cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  onClick={() => deleteUser.mutate(u.id)}
                                >
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Password change dialog */}
      <Dialog open={!!passwordDialogUser} onOpenChange={(open) => {
        if (!open) { setPasswordDialogUser(null); setNewPassword(''); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Password for {passwordDialogUser?.email}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="adminNewPassword">New Password</Label>
              <Input
                id="adminNewPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min 12 characters"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setPasswordDialogUser(null)}>
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

      <Dialog open={!!resetTwoFactorUser} onOpenChange={(open) => {
        if (!open) { setResetTwoFactorUser(null); setAdminPassword(''); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset 2FA for {resetTwoFactorUser?.email}</DialogTitle>
            <DialogDescription>
              For a user who lost their authenticator and recovery codes. Two-factor authentication is turned off and
              they are signed out everywhere; they sign in with their password and can set it up again. Check that the
              request really comes from them first.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (resetTwoFactorUser && adminPassword) resetTwoFactor.mutate({ user: resetTwoFactorUser, currentPassword: adminPassword });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="adminResetPassword">Your password</Label>
              <Input
                id="adminResetPassword"
                type="password"
                autoComplete="current-password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => { setResetTwoFactorUser(null); setAdminPassword(''); }}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={resetTwoFactor.isPending || !adminPassword}>
                {resetTwoFactor.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Reset 2FA
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminUsers;
