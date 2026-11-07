import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { AdminCalendarAccount, AdminCalendarAccountCreateRequest, AdminMailAccount, AdminMailAccountCreateRequest } from '@/lib/admin-api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioRow } from '@/components/ui/radio';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TargetLine } from '@/components/admin/PasswordConfirmDialog';
import { mailProviders } from '@/components/mail/mail-page-model';

// The administrator's dialogs for a person's accounts (F13, accounts.admin_manage):
// the same fields as the person's own add dialog, plus the administrator's
// password. No policy greys anything here: the admin path is always open.

type MailFields = Omit<AdminMailAccountCreateRequest, 'current_password'>;
type CalendarFields = Omit<AdminCalendarAccountCreateRequest, 'current_password'>;

function Field({ id, label, hint, ...props }: { id: string; label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// The same provider choice as the person's own dialog: it fills the servers of a known provider, and the server requires it.
const emptyMail = (): MailFields => ({ email_address: '', display_name: '', provider: 'custom', username: '', encrypted_password: '', imap_host: '', imap_port: 993, smtp_host: '', smtp_port: 587, sync_mode: 'download', delete_emails_on_server: false });

/**
 * Adds a mail account for the person, or changes one. Editing keeps the
 * stored password unless a new one is typed; the address cannot change.
 */
export function AdminMailAccountDialog({ account, open, onClose, pending, onSubmit, target }: {
  account: AdminMailAccount | null; open: boolean; onClose: () => void; pending: boolean;
  onSubmit: (fields: Partial<MailFields>, currentPassword: string) => void;
  /** The person the account belongs to, always shown. */
  target?: string;
}) {
  const [fields, setFields] = useState<MailFields>(emptyMail);
  // The server fields the administrator typed into; the others stay as they are on the account.
  const [edited, setEdited] = useState<Set<keyof MailFields>>(() => new Set());
  const [adminPassword, setAdminPassword] = useState('');
  useEffect(() => {
    setAdminPassword('');
    setEdited(new Set());
    setFields(open && account ? { ...emptyMail(), email_address: account.email_address, display_name: account.display_name ?? '', provider: account.provider, sync_mode: account.sync_mode, delete_emails_on_server: account.delete_emails_on_server } : emptyMail());
  }, [open, account]);
  const set = <K extends keyof MailFields>(key: K, value: MailFields[K]) => {
    setFields(current => ({ ...current, [key]: value }));
    setEdited(current => new Set(current).add(key));
  };
  const changeProvider = (provider: string) => {
    const known = mailProviders.find(entry => entry.value === provider);
    setFields(current => ({ ...current, provider, imap_host: known?.imapHost || '', smtp_host: known?.smtpHost || '', imap_port: known?.imapPort || 993, smtp_port: known?.smtpPort || 587 }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!adminPassword) return;
    if (account) {
      const change: Partial<MailFields> = { display_name: fields.display_name, sync_mode: fields.sync_mode, delete_emails_on_server: fields.sync_mode === 'download' && fields.delete_emails_on_server };
      if (fields.encrypted_password) change.encrypted_password = fields.encrypted_password;
      for (const key of ['username', 'imap_host', 'smtp_host'] as const) if (edited.has(key) && fields[key]) change[key] = fields[key];
      for (const key of ['imap_port', 'smtp_port'] as const) if (edited.has(key) && fields[key]) change[key] = fields[key];
      onSubmit(change, adminPassword);
    } else {
      onSubmit({ ...fields, username: fields.username || fields.email_address, delete_emails_on_server: fields.sync_mode === 'download' && fields.delete_emails_on_server }, adminPassword);
    }
    // Sent: the administrator's password lives in no state beyond the request; a refusal asks for it again.
    setAdminPassword('');
  };
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !pending) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{account ? `Change ${account.email_address}` : 'Add a mail account'}</DialogTitle>
          <DialogDescription>{account ? 'Only the fields you fill in change; the password stays unless you type a new one.' : 'The account is checked against its servers as if the person added it, and recorded in the activity log.'}</DialogDescription>
        </DialogHeader>
        {target && <TargetLine target={target} />}
        <form className="space-y-4" onSubmit={submit}>
          {!account && (
            <div className="space-y-1.5">
              <Label htmlFor="admin-mail-provider">Provider</Label>
              <Select value={fields.provider ?? 'custom'} onValueChange={changeProvider}>
                <SelectTrigger id="admin-mail-provider"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {mailProviders.map(entry => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="admin-mail-address" label="Email address" type="email" required value={fields.email_address} disabled={!!account} onChange={event => set('email_address', event.target.value)} autoComplete="off" />
            <Field id="admin-mail-name" label="Display name" value={fields.display_name ?? ''} onChange={event => set('display_name', event.target.value)} autoComplete="off" />
            <Field id="admin-mail-username" label="Username" hint="Leave empty to use the address." value={fields.username ?? ''} onChange={event => set('username', event.target.value)} autoComplete="off" />
            <Field id="admin-mail-password" label={account ? 'New mail password' : 'Mail password'} type="password" required={!account} value={fields.encrypted_password} onChange={event => set('encrypted_password', event.target.value)} autoComplete="new-password" />
            <Field id="admin-mail-imap-host" label="IMAP server" required={!account} value={fields.imap_host ?? ''} onChange={event => set('imap_host', event.target.value)} autoComplete="off" />
            <Field id="admin-mail-imap-port" label="IMAP port" type="number" value={fields.imap_port ?? 993} onChange={event => set('imap_port', Number(event.target.value) || 993)} />
            <Field id="admin-mail-smtp-host" label="SMTP server" required={!account} value={fields.smtp_host ?? ''} onChange={event => set('smtp_host', event.target.value)} autoComplete="off" />
            <Field id="admin-mail-smtp-port" label="SMTP port" type="number" value={fields.smtp_port ?? 587} onChange={event => set('smtp_port', Number(event.target.value) || 587)} />
          </div>
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm font-medium">Mode</legend>
            <RadioRow id="admin-mail-mode-download" name="admin-mail-mode" label="Download" description="UniHub keeps a copy and never changes the mail server." checked={fields.sync_mode === 'download'} onChange={() => set('sync_mode', 'download')} />
            <RadioRow id="admin-mail-mode-sync" name="admin-mail-mode" label="Sync" description="The mail server decides what the person sees." checked={fields.sync_mode === 'sync'} onChange={() => set('sync_mode', 'sync')} />
            {fields.sync_mode === 'download' && (
              <label className="flex items-start gap-3 px-2 py-2 text-sm">
                <Checkbox checked={!!fields.delete_emails_on_server} onCheckedChange={checked => set('delete_emails_on_server', checked === true)} />
                <span>Delete downloaded mail at the provider<span className="block text-xs text-muted-foreground">After a 10-minute grace. Their backups then always include this account's mail.</span></span>
              </label>
            )}
          </fieldset>
          <Field id="admin-mail-confirm" label="Your password" type="password" required value={adminPassword} onChange={event => setAdminPassword(event.target.value)} autoComplete="current-password" />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending || !adminPassword}>{pending && <Loader2 aria-hidden="true" className="animate-spin" />}{account ? 'Save changes' : 'Add account'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const emptyCalendar = (): CalendarFields => ({ provider: 'caldav', url: '', account_email: '', display_name: '', username: '', password: '' });

/** Adds a calendar account (CalDAV or an ICS subscription) for the person, or changes one. */
export function AdminCalendarAccountDialog({ account, open, onClose, pending, onSubmit, target }: {
  account: AdminCalendarAccount | null; open: boolean; onClose: () => void; pending: boolean;
  onSubmit: (fields: Partial<CalendarFields>, currentPassword: string) => void;
  target?: string;
}) {
  const [fields, setFields] = useState<CalendarFields>(emptyCalendar);
  const [adminPassword, setAdminPassword] = useState('');
  useEffect(() => {
    setAdminPassword('');
    setFields(open && account ? { ...emptyCalendar(), provider: account.provider === 'ics' ? 'ics' : 'caldav', account_email: account.account_email ?? '', display_name: account.display_name ?? '' } : emptyCalendar());
  }, [open, account]);
  const set = <K extends keyof CalendarFields>(key: K, value: CalendarFields[K]) => setFields(current => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!adminPassword) return;
    if (account) {
      const change: Partial<CalendarFields> = { display_name: fields.display_name, account_email: fields.account_email };
      for (const key of ['url', 'username', 'password'] as const) if (fields[key]) change[key] = fields[key];
      onSubmit(change, adminPassword);
    } else onSubmit(fields, adminPassword);
    setAdminPassword('');
  };
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !pending) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{account ? `Change ${account.display_name || account.account_email || 'the calendar account'}` : 'Add a calendar account'}</DialogTitle>
          <DialogDescription>{account ? 'Only the fields you fill in change.' : 'A CalDAV server (HTTPS) or a calendar subscription, checked as if the person added it.'}</DialogDescription>
        </DialogHeader>
        {target && <TargetLine target={target} />}
        <form className="space-y-4" onSubmit={submit}>
          {!account && (
            <fieldset className="space-y-1">
              <legend className="mb-1 text-sm font-medium">Kind</legend>
              <RadioRow id="admin-cal-caldav" name="admin-cal-kind" label="CalDAV account" checked={fields.provider === 'caldav'} onChange={() => set('provider', 'caldav')} />
              <RadioRow id="admin-cal-ics" name="admin-cal-kind" label="Calendar subscription (ICS)" description="Read-only." checked={fields.provider === 'ics'} onChange={() => set('provider', 'ics')} />
            </fieldset>
          )}
          <Field id="admin-cal-url" label="Address" type="url" required={!account} value={fields.url} onChange={event => set('url', event.target.value)} autoComplete="off" placeholder="https://" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="admin-cal-name" label="Display name" value={fields.display_name ?? ''} onChange={event => set('display_name', event.target.value)} autoComplete="off" />
            <Field id="admin-cal-email" label="Account email" type="email" value={fields.account_email ?? ''} onChange={event => set('account_email', event.target.value)} autoComplete="off" />
            {fields.provider === 'caldav' && <>
              <Field id="admin-cal-username" label="Username" value={fields.username ?? ''} onChange={event => set('username', event.target.value)} autoComplete="off" />
              <Field id="admin-cal-password" label={account ? 'New password' : 'Password'} type="password" value={fields.password ?? ''} onChange={event => set('password', event.target.value)} autoComplete="new-password" />
            </>}
          </div>
          <Field id="admin-cal-confirm" label="Your password" type="password" required value={adminPassword} onChange={event => setAdminPassword(event.target.value)} autoComplete="current-password" />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending || !adminPassword}>{pending && <Loader2 aria-hidden="true" className="animate-spin" />}{account ? 'Save changes' : 'Add account'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
