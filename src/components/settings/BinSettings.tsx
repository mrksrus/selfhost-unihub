import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useContext } from 'react';
import { AuthContext } from '@/contexts/auth-context';
import { BIN_RETENTIONS, binApi, binQueryOptions, invalidateBinQueries, type BinRetention } from '@/lib/bin-api';
import { userSettingsQueryKey, userSettingsQueryOptions, type ResolvedSetting } from '@/lib/settings-api';
import { allowedByFloor, policyReason } from '@/components/settings/setting-policy';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { BinView } from '@/components/bin/BinView';

// The retention order from the least to the most private: a floor set by an
// administrator (D34, when decided) greys out the shorter choices.
const RETENTION_ORDER: readonly BinRetention[] = ['7', '30', '90', 'forever'];

/**
 * The `bin_retention` setting as the server resolves it, once the registry
 * carries the key; until then the choice comes from the bin's answer.
 */
function retentionSetting(settings: object | undefined): ResolvedSetting<BinRetention> | undefined {
  return (settings as Record<string, ResolvedSetting<BinRetention>> | undefined)?.bin_retention;
}

/** Settings → Bin: how long deleted items wait, and everything in the bin. */
export default function BinSettings() {
  const { toast } = useToast();
  const isOffline = !!useContext(AuthContext)?.isOffline;
  const client = useQueryClient();
  const settings = useQuery({ ...userSettingsQueryOptions, enabled: !isOffline });
  const bin = useQuery({ ...binQueryOptions(), enabled: !isOffline });
  const setting = retentionSetting(settings.data);
  const retention = setting?.value ?? bin.data?.retention;
  const lock = setting ? policyReason(setting) : undefined;

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
                  <SelectItem key={choice.value} value={choice.value} disabled={!!setting && !allowedByFloor(setting, RETENTION_ORDER, choice.value)}>{choice.label}</SelectItem>
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
