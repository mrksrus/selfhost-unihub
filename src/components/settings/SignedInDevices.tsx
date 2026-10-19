import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/page-states';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { accountSessionsQueryKey, describeDevice, fetchAccountSessions, lastActiveLabel, signOutSession } from '@/lib/account-api';

/** The account's signed-in browsers and apps; any device but this one can be signed out. */
export function SignedInDevices() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const query = useQuery({ queryKey: accountSessionsQueryKey, queryFn: ({ signal }) => fetchAccountSessions(signal) });

  const signOut = async (id: string) => {
    setSigningOut(id);
    try {
      await signOutSession(id);
      toast({ title: 'Device signed out' });
    } catch (error) {
      toast({ title: 'Could not sign out the device', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    } finally {
      setSigningOut(null);
      void queryClient.invalidateQueries({ queryKey: accountSessionsQueryKey });
    }
  };

  return (
    <SettingsSection title="Signed-in devices" description="Sign out a device you do not recognize, then change your password.">
      {query.isLoading && <SettingsBlock><p className="text-sm text-muted-foreground">Loading devices…</p></SettingsBlock>}
      {query.error && (
        <SettingsBlock>
          <ErrorState title="Could not load signed-in devices" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </SettingsBlock>
      )}
      {query.data?.map(session => (
        <SettingsRow key={session.id} label={describeDevice(session.userAgent)}
          description={[session.current ? 'This device' : `Active ${lastActiveLabel(session.lastActiveAt)}`, session.ipAddress].filter(Boolean).join(' · ')}>
          {!session.current && (
            <Button variant="outline" onClick={() => void signOut(session.id)} disabled={signingOut !== null}
              aria-label={`Sign out ${describeDevice(session.userAgent)}`}>
              {signingOut === session.id && <Loader2 aria-hidden="true" className="animate-spin" />}Sign out
            </Button>
          )}
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
