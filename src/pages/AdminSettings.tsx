import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { HardDrive, KeyRound, Loader2, Shield, Users } from 'lucide-react';
import { motion } from 'framer-motion';

type StorageSection = {
  key: string;
  label: string;
  bytes: number;
  files: number;
  tracked_bytes?: number;
  tracked_items?: number;
  ready_items?: number;
  path_exists: boolean;
  scan_error: string | null;
};

type StorageUser = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  is_active: boolean;
  orphaned: boolean;
  bytes: number;
  files: number;
  sections: Record<string, { bytes: number; files: number }>;
};

type StorageOverview = {
  generated_at: string;
  totals: {
    users: number;
    active_users: number;
    mail_accounts: number;
    emails: number;
    contacts: number;
    calendar_events: number;
    bytes: number;
    files: number;
  };
  sections: StorageSection[];
  users: StorageUser[];
};

function formatBytes(value: number | null | undefined) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

function formatUserLabel(user: StorageUser) {
  if (user.full_name && user.email) return `${user.full_name} (${user.email})`;
  return user.email || user.full_name || user.user_id;
}

const AdminSettings = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: signupMode = 'disabled', isLoading } = useQuery({
    queryKey: ['admin', 'signup-mode'],
    queryFn: async () => {
      const response = await api.get<{ signup_mode: string }>('/admin/settings/signup-mode');
      if (response.error) throw new Error(response.error);
      return response.data?.signup_mode || 'disabled';
    },
    enabled: user?.role === 'admin',
  });

  const { data: storageOverview, isLoading: storageLoading } = useQuery({
    queryKey: ['admin', 'storage'],
    queryFn: async () => {
      const response = await api.get<{ storage: StorageOverview }>('/admin/storage');
      if (response.error) throw new Error(response.error);
      return response.data?.storage || null;
    },
    enabled: user?.role === 'admin',
  });

  const updateSignupMode = useMutation({
    mutationFn: async (mode: string) => {
      const response = await api.put('/admin/settings/signup-mode', { signup_mode: mode });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'signup-mode'] });
      toast({ title: 'Signup settings updated' });
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to update settings', description: err.message, variant: 'destructive' });
    },
  });

  if (user?.role !== 'admin') {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto">
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">You do not have permission to view this page.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <h1 className="text-2xl font-bold text-foreground">Admin Settings</h1>
        <p className="text-muted-foreground">Server-wide settings separate from your personal preferences</p>
      </motion.div>

      <Alert>
        <KeyRound className="h-4 w-4" />
        <AlertTitle>Deployment Secrets</AlertTitle>
        <AlertDescription>
          UniHub cannot verify whether existing deployment secrets are strong. Admins should keep JWT_SECRET and
          ENCRYPTION_KEY long, random, unique, and stored outside the app. Rotating ENCRYPTION_KEY requires planning
          because stored mail and calendar credentials depend on it.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="general" className="space-y-6">
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
          <TabsList className="h-11 w-max min-w-full justify-start gap-1 rounded-none border-b border-border bg-transparent p-0 text-muted-foreground lg:min-w-0 lg:rounded-md lg:border lg:bg-muted lg:p-1">
            <TabsTrigger value="general" className="h-11 shrink-0 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none lg:h-9 lg:rounded-sm lg:border-b-0 lg:data-[state=active]:bg-background lg:data-[state=active]:shadow-sm">
              General
            </TabsTrigger>
            <TabsTrigger value="signup" className="h-11 shrink-0 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none lg:h-9 lg:rounded-sm lg:border-b-0 lg:data-[state=active]:bg-background lg:data-[state=active]:shadow-sm">
              Signup
            </TabsTrigger>
            <TabsTrigger value="users" className="h-11 shrink-0 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none lg:h-9 lg:rounded-sm lg:border-b-0 lg:data-[state=active]:bg-background lg:data-[state=active]:shadow-sm">
              Users
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="general" className="mt-0">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <HardDrive className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Storage Overview</CardTitle>
                  <CardDescription>Aggregate counts and disk usage for server-owned storage.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {storageLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : !storageOverview ? (
                <p className="text-sm text-muted-foreground">Storage overview is unavailable.</p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-md border border-border p-3">
                      <p className="text-sm text-muted-foreground">Total storage</p>
                      <p className="mt-1 text-2xl font-semibold text-foreground">{formatBytes(storageOverview.totals.bytes)}</p>
                      <p className="text-xs text-muted-foreground">{storageOverview.totals.files} files</p>
                    </div>
                    <div className="rounded-md border border-border p-3">
                      <p className="text-sm text-muted-foreground">Users</p>
                      <p className="mt-1 text-2xl font-semibold text-foreground">{storageOverview.totals.users}</p>
                      <p className="text-xs text-muted-foreground">{storageOverview.totals.active_users} active</p>
                    </div>
                    <div className="rounded-md border border-border p-3">
                      <p className="text-sm text-muted-foreground">Mail</p>
                      <p className="mt-1 text-2xl font-semibold text-foreground">{storageOverview.totals.emails}</p>
                      <p className="text-xs text-muted-foreground">{storageOverview.totals.mail_accounts} accounts</p>
                    </div>
                    <div className="rounded-md border border-border p-3">
                      <p className="text-sm text-muted-foreground">Records</p>
                      <p className="mt-1 text-2xl font-semibold text-foreground">
                        {storageOverview.totals.contacts + storageOverview.totals.calendar_events}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {storageOverview.totals.contacts} contacts, {storageOverview.totals.calendar_events} calendar/todo
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {storageOverview.sections.map((section) => (
                      <div key={section.key} className="rounded-md border border-border p-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="font-medium text-foreground">{section.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {section.files} files
                              {section.tracked_items !== undefined ? ` • ${section.tracked_items} tracked items` : ''}
                              {section.ready_items !== undefined ? ` • ${section.ready_items} ready` : ''}
                            </p>
                          </div>
                          <div className="text-left sm:text-right">
                            <p className="font-semibold text-foreground">{formatBytes(section.bytes)}</p>
                            {section.tracked_bytes !== undefined && (
                              <p className="text-xs text-muted-foreground">DB tracked {formatBytes(section.tracked_bytes)}</p>
                            )}
                          </div>
                        </div>
                        {(!section.path_exists || section.scan_error) && (
                          <p className="mt-2 text-xs text-destructive">
                            {section.scan_error || 'Storage path does not exist yet.'}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="space-y-3">
                    <div>
                      <p className="font-medium text-foreground">Per-user storage</p>
                      <p className="text-sm text-muted-foreground">Aggregate disk usage split by account.</p>
                    </div>
                    {(storageOverview.users || []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No user storage data yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {storageOverview.users.map((storageUser) => {
                          const share = storageOverview.totals.bytes > 0
                            ? Math.min(100, (storageUser.bytes / storageOverview.totals.bytes) * 100)
                            : 0;
                          const sections = storageUser.sections || {};
                          return (
                            <div key={storageUser.user_id} className="rounded-md border border-border p-3">
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <p className="truncate font-medium text-foreground">
                                    {formatUserLabel(storageUser)}
                                    {storageUser.orphaned ? ' (orphaned storage)' : ''}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {storageUser.files} files
                                    {!storageUser.is_active && !storageUser.orphaned ? ' • inactive' : ''}
                                  </p>
                                </div>
                                <div className="text-left sm:text-right">
                                  <p className="font-semibold text-foreground">{formatBytes(storageUser.bytes)}</p>
                                  <p className="text-xs text-muted-foreground">{share.toFixed(1)}%</p>
                                </div>
                              </div>
                              <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                                <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
                              </div>
                              <p className="mt-2 text-xs text-muted-foreground">
                                Attachments {formatBytes(sections.mail_attachments?.bytes)} • Raw mail {formatBytes(sections.mail_raw?.bytes)} • Recordings {formatBytes(sections.recordings?.bytes)} • Exports {formatBytes(sections.exports?.bytes)}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Last scanned {new Date(storageOverview.generated_at).toLocaleString()}. This view exposes aggregate storage metadata only.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="signup" className="mt-0">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <Shield className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Signup Settings</CardTitle>
                  <CardDescription>Control who can create accounts</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {isLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <div className="max-w-md space-y-2">
                  <Select
                    value={signupMode}
                    onValueChange={(mode) => updateSignupMode.mutate(mode)}
                    disabled={updateSignupMode.isPending}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">Open (anyone can sign up)</SelectItem>
                      <SelectItem value="approval">Approval required</SelectItem>
                      <SelectItem value="disabled">Disabled</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">
                    {signupMode === 'open' && 'New users can sign up and immediately access the app.'}
                    {signupMode === 'approval' && 'New users can sign up but need admin approval before accessing the app.'}
                    {signupMode === 'disabled' && 'New user signups are disabled.'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users" className="mt-0">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <Users className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">User Management</CardTitle>
                  <CardDescription>Promote admins, activate accounts, reset passwords, and delete users</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link to="/admin/users">Open User Management</Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AdminSettings;
