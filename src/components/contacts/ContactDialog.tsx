import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { contactEmails, contactPhones, type Contact, type ContactInput } from '@/lib/contacts-api';
import type { ContactActions } from '@/hooks/use-contact-actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export type ContactDialogTarget = { kind: 'new'; name?: string; email?: string } | { kind: 'edit'; contact: Contact } | null;

interface Form { first_name: string; last_name: string; emails: string[]; phones: string[]; company: string; job_title: string; notes: string }

const MAX_VALUES = 3;
const emptyForm: Form = { first_name: '', last_name: '', emails: [''], phones: [''], company: '', job_title: '', notes: '' };

function formFor(target: ContactDialogTarget): Form {
  if (!target) return emptyForm;
  if (target.kind === 'new') return { ...emptyForm, first_name: target.name ?? '', emails: [target.email ?? ''] };
  const contact = target.contact;
  const emails = contactEmails(contact);
  const phones = contactPhones(contact);
  return {
    first_name: contact.first_name || '', last_name: contact.last_name || '',
    emails: emails.length ? emails : [''], phones: phones.length ? phones : [''],
    company: contact.company || '', job_title: contact.job_title || '', notes: contact.notes || '',
  };
}

function toInput(form: Form): ContactInput {
  const emails = form.emails.map(value => value.trim()).filter(Boolean);
  const phones = form.phones.map(value => value.trim()).filter(Boolean);
  return {
    first_name: form.first_name.trim(), last_name: form.last_name.trim(),
    email: emails[0] ?? '', email2: emails[1] ?? '', email3: emails[2] ?? '',
    phone: phones[0] ?? '', phone2: phones[1] ?? '', phone3: phones[2] ?? '',
    company: form.company.trim(), job_title: form.job_title.trim(), notes: form.notes,
  };
}

/** Up to three values of one kind (email addresses, phone numbers). */
function ValueList({ id, label, type, values, onChange, addLabel }: {
  id: string; label: string; type: string; values: string[]; onChange: (values: string[]) => void; addLabel: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      {values.map((value, index) => (
        <Input key={index} id={index === 0 ? id : undefined} type={type} value={value}
          aria-label={index === 0 ? undefined : `${label} ${index + 1}`}
          onChange={event => onChange(values.map((current, at) => at === index ? event.target.value : current))} />
      ))}
      {values.length < MAX_VALUES && values[values.length - 1]?.trim() && (
        <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => onChange([...values, ''])}>
          <Plus aria-hidden="true" />{addLabel}
        </Button>
      )}
    </fieldset>
  );
}

export function ContactDialog({ target, onClose, actions, onSaved }: {
  target: ContactDialogTarget; onClose: () => void; actions: ContactActions; onSaved?: (id: string | null) => void;
}) {
  const [form, setForm] = useState<Form>(emptyForm);
  const editing = target?.kind === 'edit' ? target.contact : null;
  const pending = actions.create.isPending || actions.update.isPending;

  useEffect(() => { if (target) setForm(formFor(target)); }, [target]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(prev => ({ ...prev, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = toInput(form);
    if (editing) {
      actions.update.mutate({ id: editing.id, contact: input }, { onSuccess: () => { onSaved?.(editing.id); onClose(); } });
    } else {
      actions.create.mutate(input, { onSuccess: () => { onSaved?.(null); onClose(); } });
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{editing ? 'Edit contact' : 'New contact'}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="contact-first-name">First name</Label>
              <Input id="contact-first-name" value={form.first_name} onChange={event => set('first_name', event.target.value)}
                required={!editing} autoFocus={!editing} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-last-name">Last name</Label>
              <Input id="contact-last-name" value={form.last_name} onChange={event => set('last_name', event.target.value)} />
            </div>
          </div>
          <ValueList id="contact-email" label="Email" type="email" values={form.emails} onChange={emails => set('emails', emails)} addLabel="Add another email" />
          <ValueList id="contact-phone" label="Phone" type="tel" values={form.phones} onChange={phones => set('phones', phones)} addLabel="Add another phone number" />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="contact-company">Company</Label>
              <Input id="contact-company" value={form.company} onChange={event => set('company', event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-job-title">Job title</Label>
              <Input id="contact-job-title" value={form.job_title} onChange={event => set('job_title', event.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="contact-notes">Notes</Label>
            <Textarea id="contact-notes" rows={3} value={form.notes} onChange={event => set('notes', event.target.value)} />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
              {editing ? 'Save' : 'Add contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
