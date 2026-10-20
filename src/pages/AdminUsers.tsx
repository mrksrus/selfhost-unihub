import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { adminUsersQueryKey, deleteAdminUser, fetchAdminUsers, resetUserTwoFactor, setUserActive, setUserPassword, setUserRole, type AdminUser } from '@/lib/admin-api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { Loader2, MoreHorizontal } from 'lucide-react';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';

type UserRow = AdminUser;

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
  const [deactivatingUser, setDeactivatingUser] = useState<UserRow | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  // The user the reset dialog shows now, read when a request completes.
  const openResetUserId = useRef<string | null>(null);
  useEffect(() => { openResetUserId.current = resetTwoFactorUser?.id ?? null; }, [resetTwoFactorUser]);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: adminUsersQueryKey,
    queryFn: ({ signal }) => fetchAdminUsers(signal),
    enabled: user?.role === 'admin',
  });
  
  const deleteUser = useMutation({
    mutationFn: ({ userId, currentPassword }: { userId: string; currentPassword: string }) => deleteAdminUser(userId, currentPassword),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: adminUsersQueryKey });
      toast({ title: 'User deleted' });
      setDeletingUser(current => (current?.id === variables.userId ? null : current));
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to delete user', description: err.message, variant: 'destructive' });
    },
  });

  const updateUserRole = useMutation({
    mutationFn: ({ userId, role, currentPassword }: { userId: string; role: 'user' | 'admin'; currentPassword: string }) => setUserRole(userId, role, currentPassword),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: adminUsersQueryKey });
      toast({ title: variables.role === 'admin' ? 'User promoted to admin' : 'User changed to standard user' });
      setRoleChangeUser(current => (current?.id === variables.userId ? null : current));
      setAdminPassword('');
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to update role', description: err.message, variant: 'destructive' });
    },
  });
  
  const toggleUserActive = useMutation({
    mutationFn: ({ userId, is_active, currentPassword }: { userId: string; is_active: boolean; currentPassword?: string }) => setUserActive(userId, is_active, currentPassword),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: adminUsersQueryKey });
      toast({ title: variables.is_active ? 'User activated' : 'User deactivated' });
      if (!variables.is_active) setDeactivatingUser(current => (current?.id === variables.userId ? null : current));
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to update user status', description: err.message, variant: 'destructive' });
    },
  });
  
  const resetTwoFactor = useMutation({
    mutationFn: ({ user, currentPassword }: { user: UserRow; currentPassword: string }) => resetUserTwoFactor(user.id, currentPassword),
    // Report on the submitted user; the dialog may have been reopened for someone else meanwhile.
    onSuccess: (_data, { user }) => {
      queryClient.invalidateQueries({ queryKey: adminUsersQueryKey });
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
      await setUserPassword(passwordDialogUser.id, newPassword, adminPassword);
      toast({ title: `Password updated for ${passwordDialogUser.email}` });
      setPasswordDialogUser(null);
      setNewPassword('');
      setAdminPassword('');
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
                    <DropdownMenuItem onClick={() => setDeactivatingUser(u)}>Deactivate</DropdownMenuItem>
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

      <PasswordConfirmDialog
        open={!!deletingUser}
        onClose={() => setDeletingUser(null)}
        title={`Delete ${deletingUser?.email}?`}
        description="Their account and all of their data are deleted permanently. This cannot be undone."
        actionLabel="Delete user"
        destructive
        pending={deleteUser.isPending}
        onConfirm={currentPassword => { if (deletingUser) deleteUser.mutate({ userId: deletingUser.id, currentPassword }); }}
      />
      <PasswordConfirmDialog
        open={!!deactivatingUser}
        onClose={() => setDeactivatingUser(null)}
        title={`Deactivate ${deactivatingUser?.email}?`}
        description="They are signed out everywhere and cannot sign in until an admin activates the account again. Their data stays."
        actionLabel="Deactivate"
        pending={toggleUserActive.isPending}
        onConfirm={currentPassword => { if (deactivatingUser) toggleUserActive.mutate({ userId: deactivatingUser.id, is_active: false, currentPassword }); }}
      />

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

// Confirms an action on another account with the admin's own password; the
// dialog stays open with the password kept when the server refuses it.
function PasswordConfirmDialog({ open, onClose, title, description, actionLabel, destructive = false, pending, onConfirm }: {
  open: boolean; onClose: () => void; title: string; description: string; actionLabel: string;
  destructive?: boolean; pending: boolean; onConfirm: (currentPassword: string) => void;
}) {
  const [password, setPassword] = useState('');
  useEffect(() => { if (!open) setPassword(''); }, [open]);
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4 pt-2" onSubmit={event => { event.preventDefault(); if (password) onConfirm(password); }}>
          <div className="space-y-2">
            <Label htmlFor="adminConfirmPassword">Your password</Label>
            <Input id="adminConfirmPassword" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending || !password}>
              {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {actionLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default AdminUsers;
