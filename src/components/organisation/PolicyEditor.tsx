import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { useAdminPolicies, usePeople } from '@/hooks/use-organisation';
import { useToast } from '@/hooks/use-toast';
import { adminGroupsQueryKey, adminPoliciesQueryKey, adminPoliciesQueryKeyFor, adminUsersQueryKey, saveAdminPolicies, type AdminPolicy, type BinMinimum, type Person, type PolicyScope } from '@/lib/admin-api';
import { acknowledgePolicies, policiesQueryKey, type PolicyKey, type PolicyValues } from '@/lib/policies-api';
import type { AppLockArea } from '@/lib/devices-api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { AREA_LABELS, LOCKABLE_MODULES } from '@/components/app-lock/area-names';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import { formatDay, personName } from '@/components/admin/person-words';

// The rules of one scope (F13 on F1): Everyone, which is the installation,
// or one group (0.30). Each key is one row; the values come from the server,
// and a change is saved with the administrator's password in one transaction
// with its activity-log entry. Changing a rule never deletes data.
//
// A group can only make a rule stricter: its rows offer the values at least
// as strict as Everyone's, name Everyone's beside each, and choosing
// Everyone's value takes the group's own rule away. Where a person is in
// several groups the strictest applies; the server resolves that, this page
// only edits one scope at a time.
//
// Two rules read as minimums: how long people's backups are kept
// (backup.server_retention_days) and, while deleting from the bin is
// forbidden, how long the bin keeps items (bin_min_retention).

/** The bin's minimum is not a policy key: it travels as its own field and has this row key here. */
const BIN_MINIMUM_KEY = 'bin.min_retention';
type RowKey = PolicyKey | typeof BIN_MINIMUM_KEY;
type Row = { key: RowKey; label: string; description: string };
// shortcut: `groups` and `conflict` are read as optional extras until contracts/policies.ts carries them (stream A); then AdminPolicy has them.
type ScopedPolicy = AdminPolicy & { groups?: { id: string; name: string; value: unknown }[]; conflict?: boolean };

const GROUPS: { title: string; description?: string; rows: Row[] }[] = [
  {
    title: 'Sign-in',
    rows: [
      { key: 'auth.two_factor', label: 'Two-factor authentication', description: 'Applies to administrators too. A person without it is reminded at every start.' },
      { key: 'auth.password_min_length', label: 'Shortest password', description: '' },
      { key: 'auth.session_max_days', label: 'Longest time signed in', description: 'Counted from the sign-in, also while in use. Three weeks without use always end a sign-in.' },
    ],
  },
  {
    title: 'Modules and pages',
    description: 'A module that is not allowed is off for people and leaves their navigation. Its data stays, and backups include it.',
    rows: [
      { key: 'modules.mail', label: 'Mail', description: '' },
      { key: 'modules.calendar', label: 'Calendar and ToDo', description: '' },
      { key: 'modules.contacts', label: 'Contacts', description: '' },
      { key: 'modules.recordings', label: 'Recordings and Music', description: '' },
      { key: 'pages.music', label: 'Music page', description: 'The page alone, without turning Recordings off.' },
    ],
  },
  {
    title: 'Notifications',
    rows: [
      { key: 'notifications.detail', label: 'Notifications show at most', description: 'People may show less, never more. A reminder has no sender: it keeps its content unless nothing may show.' },
    ],
  },
  {
    title: 'Phone and offline',
    rows: [
      { key: 'contacts.phone_sync', label: 'Contacts on the phone', description: 'The Android app\'s copy of UniHub contacts in the phone\'s own contacts.' },
      { key: 'offline.copies', label: 'Offline reading', description: 'Mail, contacts and events kept on a device to read without a connection. A device that never comes back online keeps its copy.' },
    ],
  },
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
      { key: 'backup.delete', label: 'Deleting backups', description: 'While people may not delete their backups, you can, under People.' },
      { key: 'backup.server_retention_days', label: 'Keep users\' backups at least', description: 'Nobody deletes a backup younger than this (you excepted, under People), and nothing is deleted on its own afterwards.' },
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
    description: 'Every device of a person, administrators included. The lock is a fingerprint, face or phone PIN in the Android app and a PIN kept in the browser on the web.',
    rows: [
      { key: 'app_lock.required', label: 'App lock required', description: 'What every device must lock before it can open it.' },
      { key: 'app_lock.max_background', label: 'Longest time in the background', description: 'How long UniHub may stay unlocked while people use something else.' },
      { key: 'app_lock.screenshots', label: 'Screenshots in the Android app', description: 'Also screen recording and the picture in the recent apps.' },
    ],
  },
];
const labelOf = (key: RowKey) => GROUPS.flatMap(group => group.rows).find(row => row.key === key)?.label ?? key;

const VALUE_LABELS: Record<string, string> = {
  allowed: 'Allowed', forbidden: 'Not allowed', user_choice: 'Their choice', download: 'Download', download_delete: 'Download and delete at the provider',
  sync: 'Sync', required: 'Required for new accounts', always: 'Always', available: 'Available',
  '30': '30 days', '90': '90 days', forever: 'Until restored',
};
/** Labels a value has only under one key. */
const VALUE_LABELS_BY_KEY: Partial<Record<RowKey, Record<string, string>>> = {
  'app_lock.max_background': { none: 'No limit', '900': '15 minutes', '300': '5 minutes', '60': '1 minute', '0': 'Every time it opens' },
  'app_lock.screenshots': { allowed: 'Allowed', forbidden: 'Blocked' },
  'auth.two_factor': { optional: 'Optional', required: 'Required' },
  'auth.password_min_length': { '12': '12 characters', '14': '14 characters', '16': '16 characters', '20': '20 characters' },
  'auth.session_max_days': { none: 'No limit', '30': '30 days', '14': '14 days', '7': '7 days', '1': '1 day' },
  'notifications.detail': { full: 'Everything', sender: 'The sender only', none: 'No details' },
};
const NONE = 'none';
const valueKey = (value: unknown) => value === null ? NONE : String(value);
const valueLabel = (value: unknown, key?: RowKey): string => Array.isArray(value) ? requiredLabel(value as AppLockArea[])
  : (key && VALUE_LABELS_BY_KEY[key]?.[String(value)]) ?? (value === null ? 'No minimum' : typeof value === 'number' ? `${value} days` : VALUE_LABELS[String(value)] ?? String(value));
const requiredLabel = (areas: readonly AppLockArea[]) => areas.includes('app') ? 'Whole app' : areas.length ? areas.map(area => AREA_LABELS[area as keyof typeof AREA_LABELS]).join(', ') : 'Not required';
/** Equal values, lists included (the app lock's required areas are a list). */
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The minimum retention row of a server without the field: shown, greyed, with the reason. */
const BIN_MINIMUM_FALLBACK: AdminPolicy<never> = { value: 'forever' as never, source: 'default', default: 'forever' as never, values: ['30', '90', 'forever'] as never[], effect: null };
const BIN_MINIMUM_MISSING = 'This server does not offer a minimum yet: items stay in the bin until they are restored.';

/** The select for one policy: the default marked (for a group, Everyone's value), the effect of the chosen value under it. */
function PolicySelect({ id, rowKey, policy, value, onChange, disabled, group }: { id: string; rowKey?: RowKey; policy: AdminPolicy; value: unknown; onChange: (next: unknown) => void; disabled?: boolean; group: boolean }) {
  const byKey = new Map(policy.values.map(entry => [valueKey(entry), entry]));
  return (
    <Select value={valueKey(value)} onValueChange={key => onChange(byKey.get(key) ?? null)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full sm:w-72"><SelectValue /></SelectTrigger>
      <SelectContent>
        {policy.values.map(entry => (
          <SelectItem key={valueKey(entry)} value={valueKey(entry)}>{valueLabel(entry, rowKey)}{sameValue(entry, policy.default) ? (group ? ' (as everyone)' : ' (default)') : ''}</SelectItem>
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
 * nothing, ['app'] for the whole app, otherwise module ids). `floor` is what
 * Everyone must lock already: a group adds to it and cannot take from it.
 */
function AppLockRequiredControl({ id, value, floor, onChange, disabled }: { id: string; value: readonly AppLockArea[]; floor: readonly AppLockArea[]; onChange: (next: AppLockArea[]) => void; disabled?: boolean }) {
  const [choice, setChoice] = useState<RequiredChoice | null>(null);
  const shown = choice ?? requiredChoiceOf(value);
  const least = requiredChoiceOf(floor);
  const choose = (next: RequiredChoice) => {
    setChoice(next === 'modules' ? next : null);
    if (next === 'none') onChange([]);
    else if (next === 'app') onChange(['app']);
    else if (value.includes('app')) onChange([...floor]);
  };
  const toggle = (moduleId: AppLockArea, checked: boolean) => onChange(LOCKABLE_MODULES.filter(area => floor.includes(area) || (area === moduleId ? checked : value.includes(area))));
  return (
    <div className="w-full space-y-2">
      <Select value={shown} onValueChange={key => choose(key as RequiredChoice)} disabled={disabled || least === 'app'}>
        <SelectTrigger id={id} className="w-full sm:w-72"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none" disabled={least !== 'none'}>Not required (default)</SelectItem>
          <SelectItem value="app">Whole app</SelectItem>
          <SelectItem value="modules">Chosen modules</SelectItem>
        </SelectContent>
      </Select>
      {shown === 'modules' && (
        <ul aria-label="Required modules" className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {LOCKABLE_MODULES.map(moduleId => (
            <li key={moduleId} className="flex items-center gap-3 py-1.5 touch:py-3">
              <Checkbox id={`${id}-${moduleId}`} checked={value.includes(moduleId) || floor.includes(moduleId)} disabled={disabled || floor.includes(moduleId)} onCheckedChange={checked => toggle(moduleId, checked === true)} />
              <label htmlFor={`${id}-${moduleId}`} className="text-sm">{AREA_LABELS[moduleId as keyof typeof AREA_LABELS]}</label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Before two-factor authentication becomes required: who it reaches that has
 * none yet, and who among them is already in their 7 days (a rule of another
 * scope started them). Nobody is locked out by saving.
 */
function TwoFactorPreview({ people }: { people: readonly Person[] }) {
  const without = people.filter(person => !person.two_factor_enabled);
  const inGrace = without.filter(person => person.two_factor_grace_ends_at);
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="two-factor-preview">
      <p className="font-medium">
        {without.length === 0 ? `All ${people.length} people this covers have two-factor authentication.`
          : `${without.length} of ${people.length} ${people.length === 1 ? 'person' : 'people'} this covers ${without.length === 1 ? 'has' : 'have'} no two-factor authentication.`}
      </p>
      {without.length > 0 && <p className="mt-1 text-muted-foreground">They get 7 days to set it up and are reminded at every start. After that they can only set it up or sign out.</p>}
      {inGrace.length > 0 && (
        <ul aria-label="Already in their 7 days" className="mt-2 space-y-0.5 text-muted-foreground">
          {inGrace.map(person => <li key={person.id}>{personName(person)}: until {formatDay(person.two_factor_grace_ends_at!)}, from an earlier rule</li>)}
        </ul>
      )}
    </div>
  );
}

export function PolicyEditor({ scope, groupName }: { scope?: PolicyScope; groupName?: string }) {
  const { toast } = useToast();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Partial<Record<RowKey, unknown>>>({});
  const [confirming, setConfirming] = useState(false);
  const query = useAdminPolicies(scope);
  // shortcut: the save preview counts from the people list; switch to POST /api/admin/policies/preview when its helper lands (streams B and W).
  const people = usePeople();
  const group = !!scope;

  // The server's keys, plus the bin's minimum from its own field (greyed out where the server lacks it).
  const policies = query.data?.policies as Partial<Record<PolicyKey, ScopedPolicy>> | undefined;
  const binMinimum = query.data?.bin_min_retention;
  const policyOf = (key: RowKey): ScopedPolicy | undefined => key === BIN_MINIMUM_KEY
    ? (binMinimum ? binMinimum as unknown as ScopedPolicy : BIN_MINIMUM_FALLBACK)
    : policies?.[key];
  const changed = Object.keys(draft) as RowKey[];
  const current = (key: RowKey): unknown => (key in draft ? draft[key] : policyOf(key)?.value);
  const change = (key: RowKey, value: unknown) => setDraft(previous => {
    const next = { ...previous };
    if (sameValue(value, policyOf(key)?.value)) delete next[key]; else next[key] = value;
    return next;
  });

  // The password is a variable of the request: useSecretMutation drops it as soon as the server answers.
  const save = useSecretMutation({
    mutationFn: (currentPassword: string) => {
      // For a group, a row set back to Everyone's value gives the group's own rule up (`clear`); the rest are its values.
      const cleared = group ? changed.filter(key => sameValue(draft[key], policyOf(key)?.default)) : [];
      const { [BIN_MINIMUM_KEY]: binValue, ...values } = Object.fromEntries(changed.filter(key => !cleared.includes(key)).map(key => [key, draft[key]])) as Partial<Record<RowKey, unknown>>;
      return saveAdminPolicies(values as Partial<PolicyValues>, currentPassword, binValue as BinMinimum | undefined, scope, cleared);
    },
    onSuccess: answer => {
      client.setQueryData(adminPoliciesQueryKeyFor(scope), answer);
      // The administrator set these rules and has seen them: no notice for them. Then what shows them follows: their own
      // greyed controls, people and groups, and the other scopes' pages (this scope's answer is already in place).
      const own = JSON.stringify(adminPoliciesQueryKeyFor(scope));
      void acknowledgePolicies(answer.revision).catch(() => undefined).finally(() => {
        void client.invalidateQueries({ queryKey: policiesQueryKey });
        void client.invalidateQueries({ queryKey: adminUsersQueryKey });
        void client.invalidateQueries({ queryKey: adminGroupsQueryKey });
        void client.invalidateQueries({ queryKey: adminPoliciesQueryKey, predicate: query => JSON.stringify(query.queryKey) !== own });
      });
      setDraft({});
      setConfirming(false);
      toast({ title: 'Policies saved', description: 'Nothing was deleted; the rules apply from now on.' });
    },
    onError: (error: Error) => toast({ title: 'Could not save the policies', description: error.message, variant: 'destructive' }),
  });

  /** What greys a row out, if anything: the bin's minimum while deleting is allowed, or on a server without it. */
  const lockOf = (row: Row): string | undefined => {
    if (row.key !== BIN_MINIMUM_KEY) return undefined;
    if (!binMinimum) return BIN_MINIMUM_MISSING;
    // The draft decides as soon as the bin rule is changed here; the server's `applies` otherwise.
    const applies = 'bin.delete' in draft ? draft['bin.delete'] === 'forbidden' : binMinimum.applies;
    if (!applies) return 'Applies once "Users may empty the bin or delete for good" is not allowed.';
    return undefined;
  };

  if (query.isLoading) return <LoadingState label="Loading policies…" />;
  if (query.error || !policies) return <ErrorState title="Could not load the policies" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;

  // Who a newly required two-factor rule reaches: everyone active, or this group's active members.
  const covered = (people.data ?? []).filter(person => person.is_active && (!scope || person.groups.some(entry => entry.id === scope.groupId)));
  const requiresTwoFactor = draft['auth.two_factor'] === 'required';

  return (
    <>
      <p className="mb-8 max-w-prose text-sm text-muted-foreground">
        {group
          ? <>Rules for the members of {groupName ?? 'this group'}, on top of the rules for everyone. A group can only make a rule stricter; for a person in several groups the strictest applies. Changing a rule never deletes data.</>
          : <>Rules for everyone on this server. A rule greys out the control it concerns, with its reason, and the server refuses the action.
            Changing a rule never deletes data. Administrators can always manage a person's accounts, backups and bin for them under People.</>}
      </p>
      {GROUPS.map(section => (
        <SettingsSection key={section.title} title={section.title} description={section.description}>
          {section.rows.map(row => {
            const policy = policyOf(row.key);
            if (!policy) return null;
            const value = current(row.key);
            const id = `policy-${row.key.replace(/\./g, '-')}`;
            const pending = row.key in draft;
            const lock = lockOf(row);
            const stricter = (policy.groups ?? []).filter(entry => !sameValue(entry.value, policy.value));
            // What the row says under its name: what the rule is, what the chosen value does, and how it stands beside the other scope.
            const lines = [
              [row.description, policy.effect && !sameValue(value, policy.default) ? policy.effect : null].filter(Boolean).join(' '),
              group ? `Everyone: ${valueLabel(policy.default, row.key)}.` : '',
              stricter.length ? `Stricter in ${stricter.map(entry => `${entry.name} (${valueLabel(entry.value, row.key)})`).join(', ')}.` : '',
            ].filter(Boolean);
            return (
              <SettingsRow key={row.key} label={<>{row.label}{pending && <span className="font-normal text-accent"> · changed</span>}</>} htmlFor={id} lock={lock}
                stack={row.key === 'app_lock.required'}
                description={lines.length || policy.conflict ? <>
                  {lines.map(line => <span key={line} className="block">{line}</span>)}
                  {policy.conflict && <span className="block text-warning">Some people are in groups that disagree here. For them, this value applies.</span>}
                </> : undefined}>
                {row.key === 'app_lock.required'
                  ? <AppLockRequiredControl id={id} value={Array.isArray(value) ? value as AppLockArea[] : []} floor={group && Array.isArray(policy.default) ? policy.default as AppLockArea[] : []} onChange={next => change(row.key, next)} disabled={!!lock} />
                  : <PolicySelect id={id} rowKey={row.key} policy={policy} value={value} onChange={next => change(row.key, next)} disabled={!!lock} group={group} />}
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
      <PasswordConfirmDialog open={confirming} onClose={() => setConfirming(false)} title={group ? `Save the changed rules of ${groupName ?? 'this group'}?` : 'Save the changed rules?'}
        description={`${changed.map(labelOf).join(', ')}. Nothing is deleted; the rules apply from now on, and the people they change for are told at their next start.`}
        actionLabel="Save changes" pending={save.isPending} onConfirm={password => save.mutate(password)}>
        {requiresTwoFactor && people.data && <TwoFactorPreview people={covered} />}
      </PasswordConfirmDialog>
    </>
  );
}
