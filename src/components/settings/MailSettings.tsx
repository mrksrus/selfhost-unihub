import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useUserSettings } from '@/hooks/use-settings';
import { useMailAccounts } from '@/hooks/use-mail-queries';
import { useToast } from '@/hooks/use-toast';
import { mailQueryKeys, type MailAccount } from '@/lib/mail-api';
import { createMailTemplate, deleteMailTemplate, fetchMailTemplates, mailTemplatesKey, saveMailSignature, updateMailTemplate, type MailTemplate, type MailTemplateRequest } from '@/lib/mail-essentials-api';
import { htmlToPlainText } from '@/lib/compose-body';
import { snoozeChoiceLabel } from '@/lib/mail-times';
import { ApiError } from '@/lib/api-error';
import { plainTextToHtml, sanitizeComposeHtml } from '@/lib/mail-compose';
import type { SnoozeChoice, UserSettingValues } from '@/lib/settings-api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { ADMIN_REASON } from '@/components/settings/setting-policy';
import { settingsHref } from '@/components/settings/settings-sections';
import { RichTextField } from '@/components/settings/RichTextField';

type ComposeFormat = UserSettingValues['compose_format'];

// Every snooze time the registry allows, in its order; the snooze menu
// (mail-times.ts) labels them, so Settings offers what the menu will say.
const SNOOZE_CHOICES: SnoozeChoice[] = ['1h', '3h', 'tomorrow', '1d', '2d', 'next_week', '1w', '2w', '1mo'];
const SNOOZE_OPTIONS = SNOOZE_CHOICES.map(value => ({ value, label: snoozeChoiceLabel(value) }));
const ACCOUNT_NOTE = 'Saved with your account, so every device follows.';
const READING_FORMATS: { value: UserSettingValues['reading_format']; label: string }[] = [
  { value: 'theme', label: 'Match the app’s theme' },
  { value: 'simplified', label: 'Simplified' },
  { value: 'original', label: 'Original appearance' },
  { value: 'auto', label: 'Decide per message' },
];
const PREVIEW_LINES = [0, 1, 2, 3, 4, 5];
const COMPOSE_FEATURES: { key: 'compose_templates' | 'compose_scheduled_send' | 'compose_format_switch'; label: string; description: string }[] = [
  { key: 'compose_templates', label: 'Templates', description: 'Start a message or reply from a saved template.' },
  { key: 'compose_scheduled_send', label: 'Send later', description: 'Send a message at a chosen time.' },
  { key: 'compose_format_switch', label: 'Format switch', description: 'Change a message between formatted and plain text while writing.' },
];

const activeSenders = (accounts: MailAccount[] | undefined) => (accounts ?? []).filter(account => account.is_active && !account.disconnected_at);

export default function MailSettings() {
  const { settings, values, change, unavailable, error, refetch, refetching } = useUserSettings();
  const accountsQuery = useMailAccounts();
  const senders = activeSenders(accountsQuery.data);
  const lock = (key: keyof UserSettingValues) => settings[key].locked ? ADMIN_REASON : undefined;
  const disabled = (key: keyof UserSettingValues) => unavailable || settings[key].locked;
  const chosen = new Set<string>(values.snooze_choices);
  const toggleSnooze = (choice: SnoozeChoice, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(choice); else next.delete(choice);
    change({ snooze_choices: SNOOZE_OPTIONS.filter(option => next.has(option.value)).map(option => option.value) });
  };

  return (
    <>
      <SettingsSection title="Writing" description={ACCOUNT_NOTE}>
        {error && (
          <div className="py-4">
            <ErrorState title="Could not load your mail settings" error={error} onRetry={refetch} retrying={refetching} />
          </div>
        )}
        {senders.length > 0 && (
          <SettingsRow label="Send from" description="For new messages written from All accounts. A reply comes from the account that received the message." htmlFor="send-from" lock={lock('default_mail_account_id')}>
            <Select value={senders.some(account => account.id === values.default_mail_account_id) ? values.default_mail_account_id : 'first'} disabled={disabled('default_mail_account_id')}
              onValueChange={value => change({ default_mail_account_id: value === 'first' ? '' : value })}>
              <SelectTrigger id="send-from" className="w-full sm:w-80"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="first">First account ({senders[0].email_address})</SelectItem>
                {senders.map(account => <SelectItem key={account.id} value={account.id}>{account.email_address}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsRow>
        )}
        <SettingsRow label="Format" description="How new messages are written." htmlFor="compose-format" lock={lock('compose_format')}>
          <Select value={values.compose_format} disabled={disabled('compose_format')} onValueChange={value => change({ compose_format: value as ComposeFormat })}>
            <SelectTrigger id="compose-format" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="rich">Formatted</SelectItem>
              <SelectItem value="plain">Plain text</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Optional compose features" description="The composer shows a feature’s button only while it is switched on here.">
        {COMPOSE_FEATURES.map(feature => (
          <SettingsRow key={feature.key} label={feature.label} description={feature.description} htmlFor={feature.key} lock={lock(feature.key)}>
            <Switch id={feature.key} checked={values[feature.key]} disabled={disabled(feature.key)} onCheckedChange={checked => change({ [feature.key]: checked })} />
          </SettingsRow>
        ))}
      </SettingsSection>

      <SettingsSection title="Reading">
        <SettingsRow label="Message appearance" description="Match the app’s theme shows the reading view in dark and the original in light. A switch while reading stays for that message." htmlFor="reading-format" lock={lock('reading_format')}>
          <Select value={values.reading_format} disabled={disabled('reading_format')} onValueChange={value => change({ reading_format: value as UserSettingValues['reading_format'] })}>
            <SelectTrigger id="reading-format" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {READING_FORMATS.map(format => <SelectItem key={format.value} value={format.value}>{format.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="Conversations" description="Group a message with its replies in the list." htmlFor="mail-threaded-view" lock={lock('mail_threaded_view')}>
          <Switch id="mail-threaded-view" checked={values.mail_threaded_view} disabled={disabled('mail_threaded_view')} onCheckedChange={checked => change({ mail_threaded_view: checked })} />
        </SettingsRow>
        <SettingsRow label="Preview lines" description="Lines of the message shown under its subject in the list." htmlFor="preview-lines" lock={lock('mail_preview_lines')}>
          <Select value={String(values.mail_preview_lines)} disabled={disabled('mail_preview_lines')} onValueChange={value => change({ mail_preview_lines: Number(value) })}>
            <SelectTrigger id="preview-lines" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PREVIEW_LINES.map(lines => <SelectItem key={lines} value={String(lines)}>{lines === 0 ? 'None' : lines === 1 ? '1 line' : `${lines} lines`}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Snooze" description="The times offered when you snooze a message.">
        <SettingsRow label="Choices" description={chosen.size === 0 ? 'Nothing is offered until a time is chosen.' : undefined} lock={lock('snooze_choices')} stack>
          <div role="group" aria-label="Snooze choices" className="grid w-full grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 touch:gap-y-4">
            {SNOOZE_OPTIONS.map(option => (
              <label key={option.value} className="flex min-h-6 cursor-pointer items-center gap-2 text-sm touch:min-h-11">
                <Checkbox checked={chosen.has(option.value)} disabled={disabled('snooze_choices')} onCheckedChange={checked => toggleSnooze(option.value, checked === true)} />
                {option.label}
              </label>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>

      <TemplatesSection defaultFormat={values.compose_format} />
      <SignaturesSection senders={senders} loading={accountsQuery.isLoading} />

      <SettingsSection title="Rules">
        <SettingsRow label="Sender rules" description="Move mail from a domain or sender into a folder as it arrives.">
          <Button variant="outline" asChild><Link to={settingsHref('mail-rules')}>Open rules</Link></Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

const firstLine = (text: string | null | undefined) => (text || '').split('\n').map(line => line.trim()).find(Boolean) || '';

// ---------------------------------------------------------------------------
// Templates: saved starts for new messages and replies (inserted in the composer).

type TemplateDraft = { name: string; subject: string; format: ComposeFormat; body: string };
type TemplateEditing = { id?: string; draft: TemplateDraft } | null;

function templateDraft(template: MailTemplate | null, defaultFormat: ComposeFormat): TemplateDraft {
  if (!template) return { name: '', subject: '', format: defaultFormat, body: '' };
  return template.body_html
    ? { name: template.name, subject: template.subject, format: 'rich', body: sanitizeComposeHtml(template.body_html) }
    : { name: template.name, subject: template.subject, format: 'plain', body: template.body_text };
}
function templateRequest(draft: TemplateDraft): MailTemplateRequest {
  return draft.format === 'rich'
    ? { name: draft.name.trim(), subject: draft.subject.trim(), body_html: draft.body, body_text: htmlToPlainText(draft.body) }
    : { name: draft.name.trim(), subject: draft.subject.trim(), body_html: null, body_text: draft.body };
}

function TemplatesSection({ defaultFormat }: { defaultFormat: ComposeFormat }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<TemplateEditing>(null);
  const [deleting, setDeleting] = useState<MailTemplate | null>(null);
  // A taken name is said in the dialog, next to the name; any other failure as a toast.
  const [nameTaken, setNameTaken] = useState(false);
  const templates = useQuery({ queryKey: mailTemplatesKey, queryFn: fetchMailTemplates });
  const refresh = () => client.invalidateQueries({ queryKey: mailTemplatesKey });
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });
  // Each opened editor has its own number: a save that answers after its
  // editor was closed (and maybe another opened) leaves the open one alone.
  const opened = useRef(0);
  const open = (next: TemplateEditing) => { opened.current += 1; setNameTaken(false); setEditing(next); };
  const close = () => { opened.current += 1; setEditing(null); };
  const save = useMutation({
    mutationFn: ({ id, draft }: { id?: string; draft: TemplateDraft; editor: number }) => id ? updateMailTemplate(id, templateRequest(draft)) : createMailTemplate(templateRequest(draft)),
    onMutate: () => setNameTaken(false),
    onSuccess: (_template, { id, editor }) => { void refresh(); if (editor === opened.current) close(); toast({ title: id ? 'Template saved' : 'Template added' }); },
    onError: (error, { editor }) => {
      if (error instanceof ApiError && error.code === 'TEMPLATE_NAME_TAKEN') { if (editor === opened.current) setNameTaken(true); else failed('Could not save the template')(error); }
      else failed('Could not save the template')(error);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteMailTemplate(id),
    onSuccess: (_result, id) => { void refresh(); setDeleting(null); setEditing(current => current?.id === id ? null : current); toast({ title: 'Template deleted' }); },
    onError: failed('Could not delete the template'),
  });

  const list = () => {
    if (templates.isLoading) return <SettingsBlock><LoadingState compact label="Loading templates…" /></SettingsBlock>;
    if (templates.error) return <SettingsBlock><ErrorState title="Could not load templates" error={templates.error} onRetry={() => void templates.refetch()} retrying={templates.isFetching} /></SettingsBlock>;
    const rows = templates.data ?? [];
    if (rows.length === 0) return <SettingsBlock><p className="text-sm text-muted-foreground">No templates yet. Add one to start messages from it.</p></SettingsBlock>;
    return rows.map(template => (
      <SettingsRow key={template.id} label={template.name} description={template.subject || firstLine(template.body_text) || 'Empty'}>
        <Button variant="ghost" size="sm" className="tap-area text-accent hover:text-accent" onClick={() => open({ id: template.id, draft: templateDraft(template, defaultFormat) })}>Edit</Button>
      </SettingsRow>
    ));
  };

  return (
    <SettingsSection title="Templates" description="Saved starts for new messages and replies."
      action={<Button variant="outline" onClick={() => open({ draft: templateDraft(null, defaultFormat) })}>New template</Button>}>
      {list()}
      <TemplateDialog editing={editing} saving={save.isPending} nameTaken={nameTaken} onClose={close}
        onSave={(id, draft) => save.mutate({ id, draft, editor: opened.current })} onDelete={() => { const current = (templates.data ?? []).find(template => template.id === editing?.id); if (current) setDeleting(current); }} />
      <AlertDialog open={!!deleting} onOpenChange={open => { if (!open) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this template?</AlertDialogTitle>
            <AlertDialogDescription>“{deleting?.name}” is removed. Messages already written from it are not changed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={remove.isPending}
              onClick={event => { event.preventDefault(); if (deleting) remove.mutate(deleting.id); }}>
              {remove.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function TemplateDialog({ editing, saving, nameTaken, onClose, onSave, onDelete }: {
  editing: TemplateEditing; saving: boolean; nameTaken: boolean; onClose: () => void; onSave: (id: string | undefined, draft: TemplateDraft) => void; onDelete: () => void;
}) {
  const [draft, setDraft] = useState<TemplateDraft | null>(editing?.draft ?? null);
  useEffect(() => { setDraft(editing?.draft ?? null); }, [editing]);
  const set = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]) => setDraft(prev => prev && { ...prev, [key]: value });
  const switchFormat = (format: ComposeFormat) => setDraft(prev => {
    if (!prev || prev.format === format) return prev;
    return { ...prev, format, body: format === 'plain' ? htmlToPlainText(prev.body) : plainTextToHtml(prev.body) };
  });
  return (
    <Dialog open={!!editing} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing?.id ? 'Edit template' : 'New template'}</DialogTitle>
          <DialogDescription>The composer inserts the subject and text when the template is chosen.</DialogDescription>
        </DialogHeader>
        {draft && (
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (draft.name.trim()) onSave(editing?.id, draft); }}>
            <div className="space-y-2">
              <Label htmlFor="template-name">Name</Label>
              <Input id="template-name" value={draft.name} required maxLength={100} aria-invalid={nameTaken || undefined} aria-describedby={nameTaken ? 'template-name-taken' : undefined}
                onChange={event => set('name', event.target.value)} />
              {nameTaken && <p id="template-name-taken" role="alert" className="text-sm text-destructive">You already have a template with this name. Choose another.</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-subject">Subject</Label>
              <Input id="template-subject" value={draft.subject} maxLength={500} placeholder="Keep the message’s subject" onChange={event => set('subject', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="template-body">Text</Label>
                <Select value={draft.format} onValueChange={value => switchFormat(value as ComposeFormat)}>
                  <SelectTrigger aria-label="Template format" className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rich">Formatted</SelectItem>
                    <SelectItem value="plain">Plain text</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <RichTextField id="template-body" aria-label="Text" format={draft.format} value={draft.body} onChange={value => set('body', value)} placeholder="Write the template…" />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              {editing?.id && <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={saving} onClick={onDelete}>Delete template</Button>}
              <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving || !draft.name.trim()}>{saving && <Loader2 aria-hidden="true" className="animate-spin" />}Save</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Signatures: one per mail account, rich text with its plain version derived.

function SignaturesSection({ senders, loading }: { senders: MailAccount[]; loading: boolean }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<MailAccount | null>(null);
  // As with templates: a late save closes only the editor it came from.
  const opened = useRef(0);
  const edit = (account: MailAccount | null) => { opened.current += 1; setEditing(account); };
  const save = useMutation({
    mutationFn: ({ account, html }: { account: MailAccount; html: string; editor: number }) => saveMailSignature(account.id, { html, text: htmlToPlainText(html) }),
    onSuccess: (saved, { editor }) => {
      // The composer reads the signature from the accounts query; the answer is the stored signature.
      client.setQueryData<MailAccount[]>(mailQueryKeys.accounts, accounts => accounts?.map(account => account.id === saved.id
        ? { ...account, signature_html: saved.signature_html, signature_text: saved.signature_text } : account));
      if (editor === opened.current) edit(null);
      toast({ title: saved.signature_text ? 'Signature saved' : 'Signature removed' });
    },
    onError: (error: Error) => toast({ title: 'Could not save the signature', description: error.message, variant: 'destructive' }),
  });
  return (
    <SettingsSection title="Signatures" description="Added under new messages, replies and forwards from the account.">
      {loading && <SettingsBlock><LoadingState compact label="Loading accounts…" /></SettingsBlock>}
      {!loading && senders.length === 0 && <SettingsBlock><p className="text-sm text-muted-foreground">Add a mail account to write a signature for it.</p></SettingsBlock>}
      {senders.map(account => (
        <SettingsRow key={account.id} label={account.email_address}
          description={account.signature_text ? <span className="block truncate">{firstLine(account.signature_text)}</span> : 'No signature'}>
          <Button variant="ghost" size="sm" className="tap-area text-accent hover:text-accent" onClick={() => edit(account)}>{account.signature_text ? 'Edit' : 'Add signature'}</Button>
        </SettingsRow>
      ))}
      <SignatureDialog account={editing} saving={save.isPending} onClose={() => edit(null)} onSave={(account, html) => save.mutate({ account, html, editor: opened.current })} />
    </SettingsSection>
  );
}

function SignatureDialog({ account, saving, onClose, onSave }: {
  account: MailAccount | null; saving: boolean; onClose: () => void; onSave: (account: MailAccount, html: string) => void;
}) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    if (!account) return;
    setHtml(account.signature_html ? sanitizeComposeHtml(account.signature_html) : account.signature_text ? plainTextToHtml(account.signature_text) : '');
  }, [account]);
  const empty = !htmlToPlainText(html).trim();
  return (
    <Dialog open={!!account} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Signature</DialogTitle>
          <DialogDescription>For {account?.email_address}. Plain-text messages carry it without formatting.</DialogDescription>
        </DialogHeader>
        {account && (
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); onSave(account, empty ? '' : html); }}>
            <RichTextField id="signature-body" aria-label="Signature" format="rich" value={html} onChange={setHtml} placeholder="Your name, role, company…" />
            <DialogFooter className="gap-2 sm:gap-0">
              {account.signature_text && <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={saving} onClick={() => onSave(account, '')}>Remove</Button>}
              <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving && <Loader2 aria-hidden="true" className="animate-spin" />}Save</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
