import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useContext } from 'react';
import { AuthContext } from '@/contexts/auth-context';
import { BIN_RETENTIONS, binApi, binQueryOptions, invalidateBinQueries, type BinRetention } from '@/lib/bin-api';
import { userSettingsQueryKey, userSettingsQueryOptions } from '@/lib/settings-api';
import { BIN_RETENTION_ORDER, allowedByFloor, retentionLock } from '@/components/settings/setting-policy';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { BinView } from '@/components/bin/BinView';

// An administrator who forbids deleting from the bin for good also sets a
// minimum (D34): the server resolves it as the setting's floor, and the
// shorter choices grey out with the reason. The server refuses a shorter
// value anyway.

/** Settings → Bin: how long deleted items wait, and everything in the bin. */
export default function BinSettings() {
  const { toast } = useToast();
  const isOffline = !!useContext(AuthContext)?.isOffline;
  const client = useQueryClient();
  const settings = useQuery({ ...userSettingsQueryOptions, enabled: !isOffline });
  const bin = useInfiniteQuery({ ...binQueryOptions(), enabled: !isOffline });
  const setting = settings.data?.bin_retention;
  // The bin's own answer carries the retention too, for a server whose settings answer is late.
  const retention = setting?.value ?? bin.data?.pages[0]?.retention;
  const lock = retentionLock(setting);

  const save = useMutation({
    mutationFn: (value: BinRetention) => binApi.setRetention(value),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: userSettingsQueryKey });
      void invalidateBinQueries(client);
      toast({ title: 'Saved', description: 'Open items keep their new time.' });
    },
    onError: (error: Error) => toast({ title: 'Could not save the setting', description: error.message, variant: 'destructive' }),
  });

  return (
    <>
      <SettingsSection title="Bin" description="Deleted contacts, events, tasks, recordings and calendars wait here before they are gone for good. Mail keeps its Trash folders.">
        <SettingsRow label="Keep deleted items for" htmlFor="bin-retention" lock={lock}
          description="A shorter time also shortens the wait of items already in the bin.">
          {retention === undefined ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-muted-foreground" /> : (
            <Select value={retention} onValueChange={value => save.mutate(value as BinRetention)} disabled={!!setting?.locked || save.isPending || isOffline}>
              <SelectTrigger id="bin-retention" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {BIN_RETENTIONS.map(choice => (
                  <SelectItem key={choice.value} value={choice.value} disabled={!!setting && !allowedByFloor(setting, BIN_RETENTION_ORDER, choice.value)}>{choice.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="In the bin">
        <SettingsBlock><BinView showSettingsLink={false} /></SettingsBlock>
      </SettingsSection>
    </>
  );
}
