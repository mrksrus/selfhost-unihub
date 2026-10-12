import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { mailRulesApi, senderCandidatesQueryKey, type MailSenderRule, type RuleInput } from '@/lib/mail-rules-api';
import { invalidateMailQueries } from '@/lib/mail-api';
import { useMailAccounts, useMailFolders } from '@/hooks/use-mail-queries';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';

type Editing = { id?: string; rule: RuleInput } | null;

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

function lastSeen(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : `last ${date.toLocaleDateString()}`;
}

export default function MailRuleSettings() {
  const client = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Editing>(null);
  const [sortCursor, setSortCursor] = useState<string | null>(null);
  const candidates = useQuery({ queryKey: senderCandidatesQueryKey, queryFn: ({ signal }) => mailRulesApi.candidates(signal) });
  const { data: accounts = [] } = useMailAccounts();
  const { data: folderRows = [] } = useMailFolders();
  // Folders are listed per account; a rule names the folder by its slug.
  const folders = useMemo(() => [...new Map(folderRows.map(folder => [folder.slug, folder])).values()], [folderRows]);
  const folderName = (slug: string) => folders.find(folder => folder.slug === slug)?.display_name || slug;

  const refresh = () => client.invalidateQueries({ queryKey: senderCandidatesQueryKey });
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });

  const save = useMutation({
    mutationFn: ({ id, rule }: { id?: string; rule: RuleInput }) => mailRulesApi.save(id, rule),
    onSuccess: (_data, { id }) => { void refresh(); setEditing(null); toast({ title: id ? 'Rule saved' : 'Rule added' }); },
    onError: failed('Could not save the rule'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => mailRulesApi.remove(id),
    onSuccess: () => { void refresh(); setEditing(null); toast({ title: 'Rule deleted' }); },
    onError: failed('Could not delete the rule'),
  });
  const sort = useMutation({
    mutationFn: () => mailRulesApi.sortInbox(sortCursor),
    onSuccess: result => {
      setSortCursor(result?.complete === false && result.next_cursor ? result.next_cursor : null);
      void invalidateMailQueries(client);
      void refresh();
      const details = [
        `${result?.applied ?? 0} of ${result?.scanned ?? 0} inbox emails moved.`,
        result?.queued ? `${result.queued} also move on the mail server.` : '',
        result?.skipped ? `${result.skipped} skipped because they changed meanwhile or the folder is not on that server.` : '',
      ].filter(Boolean).join(' ');
      toast({ title: result?.complete === false ? 'Sorted part of the inbox' : 'Inbox sorted', description: details });
    },
    onError: failed('Could not sort the inbox'),
  });

  const edit = (match_type: RuleInput['match_type'], match_value: string, existing?: MailSenderRule | null) => setEditing({
    id: existing?.id,
    rule: {
      match_type, match_value,
      target_folder: existing?.target_folder || 'marketing',
      mail_account_id: existing?.mail_account_id || null,
      priority: typeof existing?.priority === 'number' ? existing.priority : 100,
      is_active: existing ? !!existing.is_active : true,
    },
  });

  const ruleText = (rule?: MailSenderRule | null) => {
    if (!rule) return null;
    const scope = rule.mail_account_id ? ` in ${rule.account_email || 'one account'}` : '';
    return rule.is_active ? `Moves to ${folderName(rule.target_folder)}${scope}` : `Rule paused (${folderName(rule.target_folder)})`;
  };

  const list = (kind: 'domains' | 'senders') => {
    if (candidates.isLoading) return <SettingsBlock><LoadingState compact label="Loading…" /></SettingsBlock>;
    if (candidates.error) return <SettingsBlock><ErrorState title="Could not load senders" error={candidates.error} onRetry={() => void candidates.refetch()} retrying={candidates.isFetching} /></SettingsBlock>;
    const rows = kind === 'domains'
      ? (candidates.data?.domains ?? []).map(entry => ({ key: entry.domain, label: entry.domain, sub: null as string | null, type: 'domain' as const, value: entry.domain, ...entry }))
      : (candidates.data?.senders ?? []).map(entry => ({ key: entry.sender_email, label: entry.sender_name || entry.sender_email, sub: entry.sender_name ? entry.sender_email : null, type: 'email' as const, value: entry.sender_email, ...entry }));
    if (rows.length === 0) return <SettingsBlock><p className="text-sm text-muted-foreground">Nothing yet. Senders appear here once mail has synced.</p></SettingsBlock>;
    return rows.map(row => (
      <SettingsRow key={row.key} label={row.label}
        description={<>
          {row.sub && <span className="block truncate">{row.sub}</span>}
          <span>{[`${row.email_count} emails`, lastSeen(row.last_received_at)].filter(Boolean).join(', ')}</span>
          {row.matching_rule && <span className="block text-foreground">{ruleText(row.matching_rule)}</span>}
        </>}>
        <Button variant="ghost" size="sm" className="text-accent hover:text-accent" onClick={() => edit(row.type, row.value, row.matching_rule)}>{row.matching_rule ? 'Edit rule' : 'Add rule'}</Button>
      </SettingsRow>
    ));
  };

  return (
    <>
      <SettingsSection title="Sender rules" description="Move mail from a domain or sender into a folder as it arrives.">
        <SettingsRow label="Sort the inbox" description={sortCursor ? 'Part of the inbox is sorted.' : 'Apply the rules to mail already in the inbox.'}>
          <Button variant="outline" onClick={() => sort.mutate()} disabled={sort.isPending}>
            {sort.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}{sortCursor ? 'Continue sorting' : 'Sort now'}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Frequent domains">
        {list('domains')}
      </SettingsSection>
      <SettingsSection title="Frequent senders">
        {list('senders')}
      </SettingsSection>

      <RuleDialog editing={editing} onClose={() => setEditing(null)} accounts={accounts} folders={folders}
        saving={save.isPending || remove.isPending}
        onSave={(id, rule) => save.mutate({ id, rule })} onDelete={id => remove.mutate(id)} />
    </>
  );
}

function RuleDialog({ editing, onClose, accounts, folders, saving, onSave, onDelete }: {
  editing: Editing; onClose: () => void; saving: boolean;
  accounts: { id: string; email_address: string; display_name?: string | null }[];
  folders: { slug: string; display_name: string }[];
  onSave: (id: string | undefined, rule: RuleInput) => void; onDelete: (id: string) => void;
}) {
  const [rule, setRule] = useState<RuleInput | null>(editing?.rule ?? null);
  useEffect(() => { setRule(editing?.rule ?? null); }, [editing]);
  const set = <K extends keyof RuleInput>(key: K, value: RuleInput[K]) => setRule(prev => prev && { ...prev, [key]: value });

  return (
    <Dialog open={!!editing} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing?.id ? 'Edit rule' : 'Add rule'}</DialogTitle>
          <DialogDescription>Mail from {rule?.match_type === 'domain' ? 'any address at ' : ''}<span className="font-medium text-foreground">{rule?.match_value}</span></DialogDescription>
        </DialogHeader>
        {rule && (
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); onSave(editing?.id, { ...rule, priority: Number(rule.priority) || 100 }); }}>
            <div className="space-y-2">
              <Label htmlFor="rule-folder">Move to</Label>
              <select id="rule-folder" className={selectClass} value={rule.target_folder} onChange={event => set('target_folder', event.target.value)}>
                {!folders.some(folder => folder.slug === rule.target_folder) && <option value={rule.target_folder}>{rule.target_folder}</option>}
                {folders.map(folder => <option key={folder.slug} value={folder.slug}>{folder.display_name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-account">For</Label>
              <select id="rule-account" className={selectClass} value={rule.mail_account_id ?? ''} onChange={event => set('mail_account_id', event.target.value || null)}>
                <option value="">All accounts</option>
                {accounts.map(account => <option key={account.id} value={account.id}>{account.display_name || account.email_address}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rule-priority">Priority</Label>
                <Input id="rule-priority" type="number" value={rule.priority} onChange={event => set('priority', Number.parseInt(event.target.value || '100', 10) || 100)} />
                <p className="text-xs text-muted-foreground">When rules overlap, the lower number wins.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rule-active">Active</Label>
                <div className="flex h-10 items-center"><Switch id="rule-active" checked={rule.is_active} onCheckedChange={checked => set('is_active', !!checked)} /></div>
              </div>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              {editing?.id && <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={saving} onClick={() => onDelete(editing.id!)}>Delete rule</Button>}
              <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving && <Loader2 aria-hidden="true" className="animate-spin" />}Save</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
