import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AppWindow, Globe, Loader2, Smartphone, type LucideIcon } from 'lucide-react';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { useModules } from '@/hooks/use-modules';
import { deviceLabel, devicesQueryKey, devicesQueryOptions, removeDevice, type DeviceKind, type DeviceSummary, type LockMethod } from '@/lib/devices-api';
import { lastActiveLabel } from '@/lib/account-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ErrorState } from '@/components/ui/page-states';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { describeScope } from '@/components/app-lock/area-names';
import type { ModulePreference } from '@/lib/modules';

const KIND_ICONS: Record<DeviceKind, LucideIcon> = { web: Globe, pwa: AppWindow, android: Smartphone };
const METHOD_WORDS: Record<LockMethod, string> = { biometric: 'fingerprint or face', device_credential: 'the phone\'s PIN', pin: 'UniHub PIN' };

/** "App lock: fingerprint or face, Mail and Contacts" or "App lock off". */
function describeDeviceLock(lock: DeviceSummary['lock'], modules: readonly ModulePreference[]) {
  if (!lock || !lock.scope.length) return 'App lock off';
  return `App lock: ${METHOD_WORDS[lock.method]}, ${describeScope(lock.scope, modules)}`;
}

/**
 * Settings → Security → Devices: this person's browsers, installed web apps
 * and Android apps with a live session (F5). One action per row: Sign out,
 * which ends that device's sessions and notifications at once. This device
 * signs out from the account menu.
 */
export function Devices() {
  const { toast } = useToast();
  const client = useQueryClient();
  const { modules } = useModules();
  const [leaving, setLeaving] = useState<DeviceSummary | null>(null);
  const query = useQuery(devicesQueryOptions);
  const signOut = useSessionMutation({
    mutationFn: (id: string) => removeDevice(id),
    onSuccess: () => { toast({ title: 'Device signed out' }); setLeaving(null); },
    onError: (error: Error) => toast({ title: 'Could not sign out the device', description: error.message, variant: 'destructive' }),
    onSettled: () => client.invalidateQueries({ queryKey: devicesQueryKey }),
  });

  return (
    <SettingsSection title="Devices" description="Where this account is signed in. Sign out a device you do not recognise, then change your password.">
      {query.isLoading && <SettingsBlock><p className="text-sm text-muted-foreground">Loading devices…</p></SettingsBlock>}
      {query.error && (
        <SettingsBlock>
          <ErrorState title="Could not load the devices" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </SettingsBlock>
      )}
      {query.data?.map(device => {
        const Icon = KIND_ICONS[device.kind] ?? Globe;
        const label = deviceLabel(device);
        return (
          <SettingsRow key={device.id}
            label={<span className="flex min-w-0 items-center gap-2"><Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{label}</span>{device.current && <Badge variant="secondary">This device</Badge>}</span>}
            description={<>
              <span className="block">{device.current ? 'In use now' : `Last used ${lastActiveLabel(device.last_seen_at)}`} · signed in since {format(new Date(device.created_at), 'd MMM yyyy')}</span>
              <span className="block">{describeDeviceLock(device.lock, modules)} · Notifications {device.notifications ? 'on' : 'off'}</span>
            </>}>
            {!device.current && (
              <Button variant="destructive" onClick={() => setLeaving(device)} disabled={signOut.isPending} aria-label={`Sign out ${label}`}>Sign out</Button>
            )}
          </SettingsRow>
        );
      })}
      {query.data?.length === 1 && <SettingsBlock><p className="text-sm text-muted-foreground">No other device is signed in.</p></SettingsBlock>}
      <AlertDialog open={leaving !== null} onOpenChange={open => { if (!open && !signOut.isPending) setLeaving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out {leaving ? deviceLabel(leaving) : 'this device'}?</AlertDialogTitle>
            <AlertDialogDescription>
              It is signed out at once and stops receiving notifications. Its offline copy and app lock are removed the next time it opens UniHub. Nothing on the server changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signOut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={event => { event.preventDefault(); if (leaving) signOut.mutate(leaving.id); }} disabled={signOut.isPending}>
              {signOut.isPending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
