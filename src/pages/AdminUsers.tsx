import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button-variants';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { Loader2, MoreHorizontal } from 'lucide-react';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';

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
  const [roleChangeUser, setRoleChangeUser] = useState<UserRow | null>(null);
  const [deletingUser, setDeletingUser] = useState<UserRow | null>(null);
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
    mutationFn: async ({ userId, role, currentPassword }: { userId: string; role: 'user' | 'admin'; currentPassword: string }) => {
      const response = await api.put(`/admin/users/${userId}/role`, { role, current_password: currentPassword });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast({ title: variables.role === 'admin' ? 'User promoted to admin' : 'User changed to standard user' });
      setRoleChangeUser(current => (current?.id === variables.userId ? null : current));
      setAdminPassword('');
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
    if (!adminPassword) {
      toast({ title: 'Enter your own password to confirm', variant: 'destructive' });
      return;
    }
    setPasswordLoading(true);
    try {
      const response = await api.put(`/admin/users/${passwordDialogUser.id}/password`, {
        new_password: newPassword,
        current_password: adminPassword,
      });
      if (response.error) {
        toast({ title: 'Failed to change password', description: response.error, variant: 'destructive' });
      } else {
        toast({ title: `Password updated for ${passwordDialogUser.email}` });
        setPasswordDialogUser(null);
        setNewPassword('');
        setAdminPassword('');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      toast({ title: 'Failed to change password', description: message, variant: 'destructive' });
    } finally {
      setPasswordLoading(false);
    }
  };

  const list = isLoading ? <LoadingState label="Loading users…" />
    : error ? <ErrorState title="Could not load users" error={error} onRetry={() => void refetch()} retrying={isFetching} />
    : (
      <ul aria-label="Users" className="divide-y divide-border border-y border-border">
        {data?.map((u) => {
          const self = u.id === user?.id;
          const meta = [u.full_name ? u.email : null, u.role === 'admin' ? 'Admin' : null, u.two_factor_enabled ? '2FA on' : null,
            `joined ${new Date(u.created_at).toLocaleDateString()}`].filter(Boolean).join(', ');
          return (
            <li key={u.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {u.full_name || u.email}{self && <span className="font-normal text-muted-foreground"> (you)</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {!u.is_active && <span className="text-warning">Inactive, </span>}{meta}
                </p>
              </div>
              {!u.is_active && (
                <Button size="sm" variant="outline" onClick={() => toggleUserActive.mutate({ userId: u.id, is_active: true })} disabled={toggleUserActive.isPending}>
                  Activate
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={`Actions for ${u.email}`}><MoreHorizontal aria-hidden="true" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => { setRoleChangeUser(u); setAdminPassword(''); }} disabled={updateUserRole.isPending}>
                    {u.role === 'admin' ? 'Remove admin rights' : 'Make admin'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setPasswordDialogUser(u); setNewPassword(''); setAdminPassword(''); }}>Set a new password</DropdownMenuItem>
                  {u.two_factor_enabled && !self && (
                    <DropdownMenuItem onClick={() => { setResetTwoFactorUser(u); setAdminPassword(''); }}>Reset 2FA</DropdownMenuItem>
                  )}
                  {u.is_active && !self && (
                    <DropdownMenuItem onClick={() => toggleUserActive.mutate({ userId: u.id, is_active: false })} disabled={toggleUserActive.isPending}>Deactivate</DropdownMenuItem>
                  )}
                  {!self && <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeletingUser(u)}>Delete user</DropdownMenuItem>
                  </>}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
    );

  return (
    <PageShell panel={<SettingsPanel active="admin-users" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope="Users" />
      <PageBody width="reading">
        {user?.role !== 'admin' ? <p className="text-sm text-muted-foreground">Only admins can see this page.</p> : (
          <>
            <div className="mb-3">
              <h2 className="text-base font-semibold">Users</h2>
              <p className="mt-1 text-sm text-muted-foreground">{data ? `${data.length} ${data.length === 1 ? 'account' : 'accounts'} on this server.` : 'Accounts on this server.'}</p>
            </div>
            {list}
          </>
        )}
      </PageBody>

      <AlertDialog open={!!deletingUser} onOpenChange={(open) => { if (!open) setDeletingUser(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deletingUser?.email}?</AlertDialogTitle>
            <AlertDialogDescription>Their account and all of their data are deleted permanently. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => { if (deletingUser) deleteUser.mutate(deletingUser.id); }}>
              Delete user
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Password change dialog */}
      <Dialog open={!!passwordDialogUser} onOpenChange={(open) => {
        if (!open) { setPasswordDialogUser(null); setNewPassword(''); setAdminPassword(''); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New password for {passwordDialogUser?.email}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="adminNewPassword">New password</Label>
              <Input
                id="adminNewPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 12 characters"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adminConfirmPassword">Your password</Label>
              <Input
                id="adminConfirmPassword"
                type="password"
                autoComplete="current-password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => { setPasswordDialogUser(null); setAdminPassword(''); }}>
                Cancel
              </Button>
              <Button onClick={handleChangePassword} disabled={passwordLoading || !adminPassword}>
                {passwordLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Set password
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
      <Dialog open={!!roleChangeUser} onOpenChange={(open) => {
        if (!open) { setRoleChangeUser(null); setAdminPassword(''); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{roleChangeUser?.role === 'admin' ? `Remove admin rights from ${roleChangeUser?.email}?` : `Make ${roleChangeUser?.email} an admin?`}</DialogTitle>
            <DialogDescription>
              {roleChangeUser?.role === 'admin'
                ? 'They keep their account and data but can no longer manage users or server settings.'
                : 'Admins can manage every account on this server, including passwords and two-factor authentication.'}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (roleChangeUser && adminPassword) {
                updateUserRole.mutate({ userId: roleChangeUser.id, role: roleChangeUser.role === 'admin' ? 'user' : 'admin', currentPassword: adminPassword });
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="adminRolePassword">Your password</Label>
              <Input
                id="adminRolePassword"
                type="password"
                autoComplete="current-password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => { setRoleChangeUser(null); setAdminPassword(''); }}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateUserRole.isPending || !adminPassword}>
                {updateUserRole.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {roleChangeUser?.role === 'admin' ? 'Remove admin rights' : 'Make admin'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
};

export default AdminUsers;
