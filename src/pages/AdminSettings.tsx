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
import { KeyRound, Loader2, Shield, Users } from 'lucide-react';
import { motion } from 'framer-motion';

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

      <Tabs defaultValue="signup" className="space-y-6">
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
          <TabsList className="h-11 w-max min-w-full justify-start gap-1 rounded-none border-b border-border bg-transparent p-0 text-muted-foreground lg:min-w-0 lg:rounded-md lg:border lg:bg-muted lg:p-1">
            <TabsTrigger value="signup" className="h-11 shrink-0 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none lg:h-9 lg:rounded-sm lg:border-b-0 lg:data-[state=active]:bg-background lg:data-[state=active]:shadow-sm">
              Signup
            </TabsTrigger>
            <TabsTrigger value="users" className="h-11 shrink-0 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none lg:h-9 lg:rounded-sm lg:border-b-0 lg:data-[state=active]:bg-background lg:data-[state=active]:shadow-sm">
              Users
            </TabsTrigger>
          </TabsList>
        </div>

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
