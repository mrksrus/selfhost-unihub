import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { useAuth } from '@/contexts/useAuth';
import { can } from '@/lib/permissions';
import { useToast } from '@/hooks/use-toast';
import { adminPoliciesQueryKey, fetchAdminPolicies, saveAdminPolicies, type AdminPolicy, type BinMinimum } from '@/lib/admin-api';
import { acknowledgePolicies, policiesQueryKey, type PolicyKey, type PolicyValues } from '@/lib/policies-api';
import type { AppLockArea } from '@/lib/devices-api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { AREA_LABELS, LOCKABLE_MODULES } from '@/components/app-lock/area-names';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';

// Server settings → Policies (F13 on F1): the data-safety rules for everyone
// on this server. Each key is one row; the values come from the server, and a
// change is saved with the administrator's password in one transaction with
// its activity-log entry. Changing a rule never deletes data. The App lock
// rules (0.29) require a lock of every device: a device without it cannot
// open the locked parts until it has one. Two rules read
// as minimums: how long users' backups are kept (backup.server_retention_days) and, while deleting
// from the bin is forbidden, how long the bin keeps items (bin_min_retention).

/** The bin's minimum is not a policy key: it travels as its own field and has this row key here. */
const BIN_MINIMUM_KEY = 'bin.min_retention';
type RowKey = PolicyKey | typeof BIN_MINIMUM_KEY;
type Row = { key: RowKey; label: string; description: string; consequence?: string };
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
      { key: 'backup.delete', label: 'Deleting backups', description: 'While people may not delete their backups, you can, under Users.' },
      { key: 'backup.server_retention_days', label: 'Keep users\' backups at least', description: 'Nobody deletes a backup younger than this (you excepted, under Users), and nothing is deleted on its own afterwards.' },
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
      { key: 'bin.delete', label: 'Users may empty the bin or delete for good', description: 'While not allowed, people cannot delete anything from their bin themselves. The automatic clean-up still runs: it keeps items at least the time below, or longer where a person keeps them longer.' },
      { key: BIN_MINIMUM_KEY, label: 'Deleted items are kept at least', description: 'Applies while the rule above is not allowed. People may keep items longer, never shorter. With Until restored, nothing in a bin is deleted on its own.' },
      { key: 'data.clear', label: 'Settings › Delete data', description: 'Deleting every contact, event, mail account or recording at once. Never allowed while the bin rule forbids deleting.' },
    ],
  },
  {
    title: 'App lock',
    description: 'Every device of every person, administrators included. The lock is a fingerprint, face or phone PIN in the Android app and a PIN kept in the browser on the web.',
    rows: [
      { key: 'app_lock.required', label: 'App lock required', description: 'What every device must lock before it can open it.' },
      { key: 'app_lock.max_background', label: 'Longest time in the background', description: 'How long UniHub may stay unlocked while people use something else.' },
      { key: 'app_lock.screenshots', label: 'Screenshots in the Android app', description: 'Also screen recording and the picture in the recent apps.' },
    ],
  },
];

const VALUE_LABELS: Record<string, string> = {
  allowed: 'Allowed', forbidden: 'Not allowed', user_choice: 'Their choice', download: 'Download', download_delete: 'Download and delete at the provider',
  sync: 'Sync', required: 'Required for new accounts', always: 'Always', available: 'Available',
  '30': '30 days', '90': '90 days', forever: 'Until restored',
};
/** Labels a value has only under one key. */
const VALUE_LABELS_BY_KEY: Partial<Record<RowKey, Record<string, string>>> = {
  'app_lock.max_background': { none: 'No limit', '900': '15 minutes', '300': '5 minutes', '60': '1 minute', '0': 'Every time it opens' },
  'app_lock.screenshots': { allowed: 'Allowed', forbidden: 'Blocked' },
};
const NONE = 'none';
const valueKey = (value: unknown) => value === null ? NONE : String(value);
const valueLabel = (value: unknown, key?: RowKey) => value === null ? 'No minimum' : typeof value === 'number' ? `${value} days`
  : (key && VALUE_LABELS_BY_KEY[key]?.[String(value)]) ?? VALUE_LABELS[String(value)] ?? String(value);
/** Equal values, lists included (the app lock's required areas are a list). */
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The minimum retention row of a server without the field: shown, greyed, with the reason. */
const BIN_MINIMUM_FALLBACK: AdminPolicy<never> = { value: 'forever' as never, source: 'default', default: 'forever' as never, values: ['30', '90', 'forever'] as never[], effect: null };
const BIN_MINIMUM_MISSING = 'This server does not offer a minimum yet: items stay in the bin until they are restored.';

/** The select for one policy, with the default marked and the effect of the chosen value under it. */
function PolicySelect({ id, rowKey, policy, value, onChange, disabled }: { id: string; rowKey?: RowKey; policy: AdminPolicy; value: unknown; onChange: (next: unknown) => void; disabled?: boolean }) {
  const byKey = new Map(policy.values.map(entry => [valueKey(entry), entry]));
  return (
    <Select value={valueKey(value)} onValueChange={key => onChange(byKey.get(key) ?? null)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full sm:w-72"><SelectValue /></SelectTrigger>
      <SelectContent>
        {policy.values.map(entry => (
          <SelectItem key={valueKey(entry)} value={valueKey(entry)}>{valueLabel(entry, rowKey)}{sameValue(entry, policy.default) ? ' (default)' : ''}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type RequiredChoice = 'none' | 'app' | 'modules';
const requiredChoiceOf = (value: readonly AppLockArea[]): RequiredChoice => value.includes('app') ? 'app' : value.length ? 'modules' : 'none';

/**
 * The required app lock: nothing, the whole app, or chosen modules with their
 * boxes under the select. The value is the list the server keeps ([] for
 * nothing, ['app'] for the whole app, otherwise module ids).
 */
function AppLockRequiredControl({ id, value, onChange, disabled }: { id: string; value: readonly AppLockArea[]; onChange: (next: AppLockArea[]) => void; disabled?: boolean }) {
  const [choice, setChoice] = useState<RequiredChoice | null>(null);
  const shown = choice ?? requiredChoiceOf(value);
  const choose = (next: RequiredChoice) => {
    setChoice(next === 'modules' ? next : null);
    if (next === 'none') onChange([]);
    else if (next === 'app') onChange(['app']);
    else if (value.includes('app')) onChange([]);
  };
  const toggle = (moduleId: AppLockArea, checked: boolean) => onChange(LOCKABLE_MODULES.filter(area => (area === moduleId ? checked : value.includes(area))));
  return (
    <div className="w-full space-y-2">
      <Select value={shown} onValueChange={key => choose(key as RequiredChoice)} disabled={disabled}>
        <SelectTrigger id={id} className="w-full sm:w-72"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Not required (default)</SelectItem>
          <SelectItem value="app">Whole app</SelectItem>
          <SelectItem value="modules">Chosen modules</SelectItem>
        </SelectContent>
      </Select>
      {shown === 'modules' && (
        <ul aria-label="Required modules" className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {LOCKABLE_MODULES.map(moduleId => (
            <li key={moduleId} className="flex items-center gap-3 py-1.5 touch:py-3">
              <Checkbox id={`${id}-${moduleId}`} checked={value.includes(moduleId)} disabled={disabled} onCheckedChange={checked => toggle(moduleId, checked === true)} />
              <label htmlFor={`${id}-${moduleId}`} className="text-sm">{AREA_LABELS[moduleId as keyof typeof AREA_LABELS]}</label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const AdminPolicies = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Partial<Record<RowKey, unknown>>>({});
  const [confirming, setConfirming] = useState(false);
  const query = useQuery({ queryKey: adminPoliciesQueryKey, queryFn: ({ signal }) => fetchAdminPolicies(signal), enabled: can(user, 'server.settings') });

  // The password is a variable of the request: useSecretMutation drops it as soon as the server answers.
  const save = useSecretMutation({
    mutationFn: (currentPassword: string) => {
      const { [BIN_MINIMUM_KEY]: binMinimum, ...values } = draft;
      return saveAdminPolicies(values as Partial<PolicyValues>, currentPassword, binMinimum as BinMinimum | undefined);
    },
    onSuccess: answer => {
      client.setQueryData(adminPoliciesQueryKey, answer);
      // The administrator set these rules and has seen them: no notice for them. Then their own greyed controls follow.
      void acknowledgePolicies(answer.revision).catch(() => undefined).finally(() => client.invalidateQueries({ queryKey: policiesQueryKey }));
      setDraft({});
      setConfirming(false);
      toast({ title: 'Policies saved', description: 'Nothing was deleted; the rules apply from now on.' });
    },
    onError: (error: Error) => toast({ title: 'Could not save the policies', description: error.message, variant: 'destructive' }),
  });

  // The server's keys, plus the bin's minimum from its own field (greyed out where the server lacks it).
  const policies = query.data?.policies as Partial<Record<PolicyKey, AdminPolicy>> | undefined;
  const binMinimum = query.data?.bin_min_retention;
  const policyOf = (key: RowKey): AdminPolicy | undefined => key === BIN_MINIMUM_KEY
    ? (binMinimum ? { value: binMinimum.value, source: binMinimum.source, default: binMinimum.default, values: binMinimum.values, effect: binMinimum.effect } as AdminPolicy<never> : BIN_MINIMUM_FALLBACK)
    : policies?.[key];
  const changed = Object.keys(draft) as RowKey[];
  const current = (key: RowKey): unknown => (key in draft ? draft[key] : policyOf(key)?.value);
  const change = (key: RowKey, value: unknown) => setDraft(previous => {
    const next = { ...previous };
    if (sameValue(value, policyOf(key)?.value)) delete next[key]; else next[key] = value;
    return next;
  });
  const labelOf = (key: RowKey) => GROUPS.flatMap(group => group.rows).find(row => row.key === key)?.label ?? key;

  /** What greys a row out, if anything: the bin's minimum while deleting is allowed, or on a server without it. */
  const lockOf = (row: Row): string | undefined => {
    if (row.key !== BIN_MINIMUM_KEY) return undefined;
    if (!binMinimum) return BIN_MINIMUM_MISSING;
    // The draft decides as soon as the bin rule is changed here; the server's `applies` otherwise.
    const applies = 'bin.delete' in draft ? draft['bin.delete'] === 'forbidden' : binMinimum.applies;
    if (!applies) return 'Applies once "Users may empty the bin or delete for good" is not allowed.';
    return undefined;
  };

  const body = !can(user, 'server.settings') ? <p className="text-sm text-muted-foreground">Only admins can see this page.</p>
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
              const policy = policyOf(row.key);
              if (!policy) return null;
              const value = current(row.key);
              const id = `policy-${row.key.replace(/\./g, '-')}`;
              const pending = row.key in draft;
              const lock = lockOf(row);
              return (
                <SettingsRow key={row.key} label={<>{row.label}{pending && <span className="font-normal text-accent"> · changed</span>}</>} htmlFor={id} lock={lock}
                  stack={row.key === 'app_lock.required'}
                  description={[row.description, policy.effect && !sameValue(value, policy.default) ? policy.effect : null].filter(Boolean).join(' ') || undefined}>
                  {row.key === 'app_lock.required'
                    ? <AppLockRequiredControl id={id} value={Array.isArray(value) ? value as AppLockArea[] : []} onChange={next => change(row.key, next)} disabled={!!lock} />
                    : <PolicySelect id={id} rowKey={row.key} policy={policy} value={value} onChange={next => change(row.key, next)} disabled={!!lock} />}
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
        description={`${changed.map(labelOf).join(', ')}. Nothing is deleted; the rules apply from now on, and people are told at their next start.`}
        actionLabel="Save changes" pending={save.isPending} onConfirm={password => save.mutate(password)} />
    </PageShell>
  );
};

export default AdminPolicies;
