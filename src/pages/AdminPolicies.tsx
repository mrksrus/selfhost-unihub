import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useToast } from '@/hooks/use-toast';
import { adminPoliciesQueryKey, fetchAdminPolicies, saveAdminPolicies, type AdminPolicy } from '@/lib/admin-api';
import { policiesQueryKey, type PolicyKey, type PolicyValues } from '@/lib/policies-api';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';

// Server settings → Policies (F13 on F1): the data-safety rules for everyone
// on this server. Each key is one row; the values come from the server, and a
// change is saved with the administrator's password in one transaction with
// its activity-log entry. Changing a rule never deletes data.

type Row = { key: PolicyKey; label: string; description: string };
const GROUPS: { title: string; description?: string; rows: Row[] }[] = [
  {
    title: 'Mail accounts',
    description: 'Existing accounts keep their mode; a rule applies when an account is added or changed.',
    rows: [
      { key: 'mail.mode.new_accounts', label: 'New accounts use', description: 'Preselected and locked in the account dialog when set.' },
      { key: 'mail.mode.download', label: 'Download mode', description: 'UniHub keeps a copy and never changes the mail server.' },
      { key: 'mail.mode.sync', label: 'Sync mode', description: 'The mail server decides what people see.' },
      { key: 'mail.provider_delete', label: 'Deleting downloaded mail at the provider', description: 'Backups then always include that account\'s mail.' },
    ],
  },
  {
    title: 'Backups',
    rows: [
      { key: 'backup.create', label: 'Creating backups', description: '' },
      { key: 'backup.restore', label: 'Restoring backups', description: '' },
      { key: 'backup.delete', label: 'Deleting backups', description: 'While people may not delete, the server removes each backup after the time below.' },
      { key: 'backup.server_retention_days', label: 'The server keeps each backup', description: 'Applies only while people may not delete backups themselves.' },
      { key: 'backup.download_mail', label: 'Downloaded mail in backups', description: 'The mail of Download-mode accounts.' },
    ],
  },
  {
    title: 'Accounts',
    rows: [
      { key: 'accounts.add', label: 'Adding mail and calendar accounts', description: '' },
      { key: 'accounts.remove', label: 'Removing accounts', description: 'Disconnecting a mail account, removing a calendar account, turning a linked calendar off.' },
      { key: 'accounts.reset', label: 'Deleting UniHub\'s copy of an account\'s mail', description: 'The provider keeps its mail either way.' },
      { key: 'account.delete', label: 'Deleting one\'s own UniHub account', description: '' },
    ],
  },
  {
    title: 'Bin and data',
    rows: [
      { key: 'bin.delete', label: 'Deleting from the bin for good', description: 'Also stops emptying the bin; items then stay until restored.' },
      { key: 'data.clear', label: 'Settings › Delete data', description: 'Deleting every contact, event, mail account or recording at once. Never allowed while the bin rule forbids deleting.' },
    ],
  },
];

const VALUE_LABELS: Record<string, string> = {
  allowed: 'Allowed', forbidden: 'Not allowed', user_choice: 'Their choice', download: 'Download', download_delete: 'Download and delete at the provider',
  sync: 'Sync', required: 'Required for new accounts', always: 'Always', available: 'Available',
};
const NONE = 'none';
const valueKey = (value: unknown) => value === null ? NONE : String(value);
const valueLabel = (value: unknown) => value === null ? 'Until they delete it' : typeof value === 'number' ? `${value} days` : VALUE_LABELS[String(value)] ?? String(value);

/** The select for one policy, with the default marked and the effect of the chosen value under it. */
function PolicySelect({ id, policy, value, onChange }: { id: string; policy: AdminPolicy; value: unknown; onChange: (next: unknown) => void }) {
  const byKey = new Map(policy.values.map(entry => [valueKey(entry), entry]));
  return (
    <Select value={valueKey(value)} onValueChange={key => onChange(byKey.get(key) ?? null)}>
      <SelectTrigger id={id} className="w-full sm:w-72"><SelectValue /></SelectTrigger>
      <SelectContent>
        {policy.values.map(entry => (
          <SelectItem key={valueKey(entry)} value={valueKey(entry)}>{valueLabel(entry)}{entry === policy.default ? ' (default)' : ''}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const AdminPolicies = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Partial<PolicyValues>>({});
  const [confirming, setConfirming] = useState(false);
  const query = useQuery({ queryKey: adminPoliciesQueryKey, queryFn: ({ signal }) => fetchAdminPolicies(signal), enabled: user?.role === 'admin' });

  const save = useMutation({
    mutationFn: (currentPassword: string) => saveAdminPolicies(draft, currentPassword),
    onSuccess: answer => {
      client.setQueryData(adminPoliciesQueryKey, answer);
      // The administrator's own greyed controls follow at once.
      void client.invalidateQueries({ queryKey: policiesQueryKey });
      setDraft({});
      setConfirming(false);
      toast({ title: 'Policies saved', description: 'Nothing was deleted; the rules apply from now on.' });
    },
    onError: (error: Error) => toast({ title: 'Could not save the policies', description: error.message, variant: 'destructive' }),
  });

  const policies = query.data?.policies;
  const changed = Object.keys(draft) as PolicyKey[];
  const current = <K extends PolicyKey>(key: K): PolicyValues[K] | undefined => (key in draft ? draft[key] : policies?.[key].value) as PolicyValues[K] | undefined;
  const change = (key: PolicyKey, value: unknown) => setDraft(previous => {
    const next = { ...previous } as Record<string, unknown>;
    if (value === policies?.[key].value) delete next[key]; else next[key] = value;
    return next as Partial<PolicyValues>;
  });

  const body = user?.role !== 'admin' ? <p className="text-sm text-muted-foreground">Only admins can see this page.</p>
    : query.isLoading ? <LoadingState label="Loading policies…" />
    : query.error || !policies ? <ErrorState title="Could not load the policies" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
    : (
      <>
        <p className="mb-8 max-w-prose text-sm text-muted-foreground">
          Rules for everyone on this server. A rule greys out the control it concerns, with its reason, and the server refuses the action.
          Changing a rule never deletes data. Administrators can always manage a person's accounts, backups and bin for them under Users.
        </p>
        {GROUPS.map(group => (
          <SettingsSection key={group.title} title={group.title} description={group.description}>
            {group.rows.map(row => {
              const policy = policies[row.key] as AdminPolicy;
              const value = current(row.key);
              const id = `policy-${row.key.replace(/\./g, '-')}`;
              const pending = row.key in draft;
              return (
                <SettingsRow key={row.key} label={<>{row.label}{pending && <span className="font-normal text-accent"> · changed</span>}</>} htmlFor={id}
                  description={[row.description, policy.effect && value !== policy.default ? policy.effect : null].filter(Boolean).join(' ') || undefined}>
                  <PolicySelect id={id} policy={policy} value={value} onChange={next => change(row.key, next)} />
                </SettingsRow>
              );
            })}
          </SettingsSection>
        ))}
        {changed.length > 0 && (
          <div className="sticky -mx-4 border-t border-border bg-background px-4 py-3 max-md:bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:bottom-0 md:-mx-6 md:px-6" role="region" aria-label="Unsaved changes">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">{changed.length === 1 ? '1 rule changed' : `${changed.length} rules changed`}</p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setDraft({})} disabled={save.isPending}>Discard</Button>
                <Button onClick={() => setConfirming(true)} disabled={save.isPending}>Save changes…</Button>
              </div>
            </div>
          </div>
        )}
        <SettingsBlock>
          <p className="text-xs text-muted-foreground">Saved changes are recorded in the activity log with your name.</p>
        </SettingsBlock>
      </>
    );

  return (
    <PageShell panel={<SettingsPanel active="admin-policies" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope="Policies" />
      <PageBody width="reading">{body}</PageBody>
      <PasswordConfirmDialog open={confirming} onClose={() => setConfirming(false)} title="Save the changed rules?"
        description={`${changed.map(key => GROUPS.flatMap(group => group.rows).find(row => row.key === key)?.label ?? key).join(', ')}. Nothing is deleted; the rules apply from now on.`}
        actionLabel="Save changes" pending={save.isPending} onConfirm={password => save.mutate(password)} />
    </PageShell>
  );
};

export default AdminPolicies;
