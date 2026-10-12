import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { User } from '@/contexts/auth-context';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';

const DEVICE_TIME_ZONE = '';
const timeZones = (() => {
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
    return [...(intl.supportedValuesOf?.('timeZone') ?? [])].sort();
  } catch {
    return [];
  }
})();

export default function AccountSettings() {
  const { user, setUser } = useAuth();
  const { toast } = useToast();
  const [fullName, setFullName] = useState(user?.full_name || '');
  const [timezone, setTimezone] = useState(user?.timezone ?? DEVICE_TIME_ZONE);

  useEffect(() => {
    setFullName(user?.full_name || '');
    setTimezone(user?.timezone ?? DEVICE_TIME_ZONE);
  }, [user?.full_name, user?.timezone]);

  const save = useMutation({
    mutationFn: async () => {
      const response = await api.put<{ user: User }>('/auth/profile', { full_name: fullName.trim(), timezone: timezone === DEVICE_TIME_ZONE ? null : timezone });
      if (response.error) throw new Error(response.error);
      return response.data?.user;
    },
    onSuccess: updated => { if (updated) setUser(updated); toast({ title: 'Profile saved' }); },
    onError: (error: Error) => toast({ title: 'Could not save the profile', description: error.message, variant: 'destructive' }),
  });

  const changed = fullName.trim() !== (user?.full_name || '') || timezone !== (user?.timezone ?? DEVICE_TIME_ZONE);
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };

  return (
    <form onSubmit={submit}>
      <SettingsSection title="Profile">
        <SettingsRow label="Email">
          <span className="text-sm">{user?.email}</span>
        </SettingsRow>
        <SettingsRow label="Name" htmlFor="profile-name">
          <Input id="profile-name" className="w-full sm:w-64" value={fullName} onChange={event => setFullName(event.target.value)} autoComplete="name" />
        </SettingsRow>
        <SettingsRow label="Time zone" description="Used for calendar and task dates and times." htmlFor="profile-timezone">
          <select id="profile-timezone" value={timezone} onChange={event => setTimezone(event.target.value)}
            className="h-10 w-full rounded-md sm:w-64 border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
            <option value={DEVICE_TIME_ZONE}>Use this device's time zone</option>
            {/* A saved zone this browser does not list (such as UTC) still shows as chosen. */}
            {(timezone && !timeZones.includes(timezone) ? [timezone, ...timeZones] : timeZones).map(zone => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </SettingsRow>
        <SettingsBlock className="flex justify-end">
          <Button type="submit" disabled={!changed || save.isPending}>
            {save.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Save profile
          </Button>
        </SettingsBlock>
      </SettingsSection>
    </form>
  );
}
