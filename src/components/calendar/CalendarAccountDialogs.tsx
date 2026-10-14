import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { isRemoteCalendarAccount, type CalendarCalendar, type CalendarProvider } from '@/lib/calendar-api';
import type { CalendarAccounts, NewCalendarAccount } from '@/hooks/use-calendar-accounts';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button-variants';

const providerOptions: { value: CalendarProvider; label: string; description: string }[] = [
  { value: 'local', label: 'On this server', description: 'Stored only in UniHub.' },
  { value: 'caldav', label: 'CalDAV server', description: 'Two-way sync. The server is found from the address; enter it only if it is not found.' },
  { value: 'ics', label: 'Subscription (read-only)', description: 'An iCalendar address (.ics or webcal://), for example the secret address of a Google calendar.' },
];

const emptyAccount: NewCalendarAccount = { provider: 'local', account_email: '', display_name: '', username: '', password: '', url: '' };

export function AddCalendarAccountDialog({ open, onOpenChange, data }: { open: boolean; onOpenChange: (open: boolean) => void; data: CalendarAccounts }) {
  const [form, setForm] = useState(emptyAccount);
  useEffect(() => { if (open) setForm(emptyAccount); }, [open]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    data.createAccount.mutate(form, { onSuccess: () => onOpenChange(false) });
  };
  const pending = data.createAccount.isPending;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add calendar account</DialogTitle>
          <DialogDescription>Calendars of a mail account are set up in that mail account's settings.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="calendar-account-provider">Type</Label>
            <Select value={form.provider} onValueChange={value => setForm(prev => ({ ...prev, provider: value as CalendarProvider }))}>
              <SelectTrigger id="calendar-account-provider"><SelectValue /></SelectTrigger>
              <SelectContent>{providerOptions.map(provider => <SelectItem key={provider.value} value={provider.value}>{provider.label}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{providerOptions.find(provider => provider.value === form.provider)?.description}</p>
          </div>
          {form.provider !== 'ics' && (
            <div className="space-y-2">
              <Label htmlFor="calendar-account-email">Email</Label>
              <Input id="calendar-account-email" type="email" placeholder="name@example.com" value={form.account_email}
                required={form.provider === 'caldav' && !form.username.trim()}
                onChange={event => setForm(prev => ({ ...prev, account_email: event.target.value }))} />
            </div>
          )}
          {form.provider === 'caldav' && <>
            <div className="space-y-2">
              <Label htmlFor="calendar-account-username">User name (optional)</Label>
              <Input id="calendar-account-username" autoComplete="username" placeholder="Same as the email if empty" value={form.username}
                onChange={event => setForm(prev => ({ ...prev, username: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="calendar-account-password">Password</Label>
              <Input id="calendar-account-password" type="password" autoComplete="current-password" placeholder="Password or app password" required value={form.password}
                onChange={event => setForm(prev => ({ ...prev, password: event.target.value }))} />
            </div>
          </>}
          {form.provider !== 'local' && (
            <div className="space-y-2">
              <Label htmlFor="calendar-account-url">{form.provider === 'ics' ? 'Subscription address' : 'Server address (optional)'}</Label>
              <Input id="calendar-account-url" autoComplete="off" spellCheck={false} required={form.provider === 'ics'} value={form.url}
                placeholder={form.provider === 'ics' ? 'https://calendar.example.com/feed.ics' : 'Found automatically, e.g. https://dav.example.com/'}
                onChange={event => setForm(prev => ({ ...prev, url: event.target.value }))} />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="calendar-account-name">Display name</Label>
            <Input id="calendar-account-name" value={form.display_name} onChange={event => setForm(prev => ({ ...prev, display_name: event.target.value }))} />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
              {pending && form.provider !== 'local' ? 'Connecting…' : form.provider === 'local' ? 'Create account' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A new calendar in an account stored on this server. */
export function AddCalendarDialog({ accountId, onClose, data }: { accountId: string | null; onClose: () => void; data: CalendarAccounts }) {
  const { toast } = useToast();
  const localAccounts = data.accounts.filter(account => !isRemoteCalendarAccount(account));
  const [form, setForm] = useState({ account_id: '', name: '', color: '#3b82f6', auto_todo_enabled: true });
  useEffect(() => { if (accountId !== null) setForm({ account_id: accountId, name: '', color: '#3b82f6', auto_todo_enabled: true }); }, [accountId]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.account_id) { toast({ title: 'Choose an account', variant: 'destructive' }); return; }
    data.createCalendar.mutate(form, { onSuccess: onClose });
  };
  return (
    <Dialog open={accountId !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add a calendar</DialogTitle></DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          {localAccounts.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="new-calendar-account">Account</Label>
              <Select value={form.account_id} onValueChange={value => setForm(prev => ({ ...prev, account_id: value }))}>
                <SelectTrigger id="new-calendar-account"><SelectValue placeholder="Choose an account" /></SelectTrigger>
                <SelectContent>{localAccounts.map(account => <SelectItem key={account.id} value={account.id}>{account.display_name || account.account_email || 'Account'}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="new-calendar-name">Name</Label>
            <Input id="new-calendar-name" required autoFocus value={form.name} onChange={event => setForm(prev => ({ ...prev, name: event.target.value }))} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="new-calendar-color" className="font-normal">Color</Label>
            <input id="new-calendar-color" type="color" className="h-8 w-14 cursor-pointer touch:h-10 rounded border border-input bg-transparent" value={form.color}
              onChange={event => setForm(prev => ({ ...prev, color: event.target.value }))} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="new-calendar-todo" className="font-normal">Show its events in ToDo</Label>
            <Switch id="new-calendar-todo" checked={form.auto_todo_enabled} onCheckedChange={checked => setForm(prev => ({ ...prev, auto_todo_enabled: checked }))} />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={data.createCalendar.isPending}>Create calendar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Color, ToDo and removal of one calendar. */
export function CalendarSettingsDialog({ calendar, onClose, data }: { calendar: CalendarCalendar | null; onClose: () => void; data: CalendarAccounts }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const account = calendar ? data.accounts.find(entry => entry.id === calendar.account_id) : undefined;
  const remote = isRemoteCalendarAccount(account);
  // Show the cached calendar so switches reflect saved changes at once.
  const current = calendar ? data.calendars.find(entry => entry.id === calendar.id) ?? calendar : null;
  return <>
    <Dialog open={!!calendar} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{current?.name}</DialogTitle>
          <DialogDescription>{account?.display_name || account?.account_email || 'Calendar settings'}</DialogDescription>
        </DialogHeader>
        {current && <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="calendar-color" className="font-normal">Color</Label>
            <input id="calendar-color" type="color" className="h-8 w-14 cursor-pointer touch:h-10 rounded border border-input bg-transparent" defaultValue={current.color}
              onBlur={event => { if (event.target.value !== current.color) data.updateCalendar.mutate({ id: current.id, data: { color: event.target.value } }); }} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="calendar-todo" className="font-normal">Show its events in ToDo</Label>
            <Switch id="calendar-todo" checked={current.auto_todo_enabled}
              onCheckedChange={value => data.updateCalendar.mutate({ id: current.id, data: { auto_todo_enabled: value } })} />
          </div>
        </div>}
        <DialogFooter className="gap-2 sm:gap-0">
          {!remote && <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>Delete calendar</Button>}
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {current?.name}?</AlertDialogTitle>
          <AlertDialogDescription>All events in this calendar are deleted. This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={buttonVariants({ variant: 'destructive' })}
            onClick={() => { if (current) data.deleteCalendar.mutate(current.id, { onSuccess: onClose }); }}>Delete calendar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
