import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { BulkContactChange, Contact } from '@/lib/contacts-api';
import type { ContactActions } from '@/hooks/use-contact-actions';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const FIELDS = [{ key: 'company', label: 'Company' }, { key: 'department', label: 'Department' }, { key: 'job_title', label: 'Job title' }] as const;
type Field = (typeof FIELDS)[number]['key'];
type Form = Record<Field, { value: string; change: boolean }>;

const read = (contact: Contact, field: Field) =>
  field === 'company' ? contact.organization.name || '' : field === 'department' ? contact.organization.department || '' : contact.job_title || '';

/** A field starts with the value all contacts share, so the current value is visible; otherwise empty. */
function formFor(contacts: Contact[]): Form {
  const shared = (field: Field) => {
    const first = contacts[0] ? read(contacts[0], field) : '';
    return contacts.every(contact => read(contact, field) === first) ? first : '';
  };
  return Object.fromEntries(FIELDS.map(field => [field.key, { value: shared(field.key), change: false }])) as Form;
}

/** Sets company, department and job title on every selected contact. Only ticked fields are sent; a ticked empty field clears it. */
export function BulkEditDialog({ contacts, onClose, actions, onSaved }: {
  contacts: Contact[] | null; onClose: () => void; actions: ContactActions; onSaved: () => void;
}) {
  // The last targets stay while the dialog animates closed.
  const [targets, setTargets] = useState<Contact[]>(contacts ?? []);
  const [form, setForm] = useState<Form>(() => formFor(targets));
  const count = targets.length;
  const changes = FIELDS.filter(field => form[field.key].change);

  useEffect(() => { if (contacts) { setTargets(contacts); setForm(formFor(contacts)); } }, [contacts]);

  const set = (key: Field, patch: Partial<Form[Field]>) => setForm(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const contact: BulkContactChange = {};
    for (const field of changes) contact[field.key] = form[field.key].value.trim() || null;
    actions.updateMany.mutate({ ids: targets.map(entry => entry.id), contact }, { onSuccess: () => { onSaved(); onClose(); } });
  };

  return (
    <Dialog open={!!contacts} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set company for {count === 1 ? '1 contact' : `${count} contacts`}</DialogTitle>
          <DialogDescription>Only ticked fields change, on every one of them.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {FIELDS.map(field => (
            <div key={field.key} className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox id={`bulk-${field.key}-change`} checked={form[field.key].change} onCheckedChange={checked => set(field.key, { change: checked === true })} />
                <Label htmlFor={`bulk-${field.key}-change`}>{field.label}</Label>
              </div>
              <Input aria-label={field.label} value={form[field.key].value} placeholder={form[field.key].change ? 'Empty removes it' : 'Not changed'}
                onChange={event => set(field.key, { value: event.target.value, change: true })} />
            </div>
          ))}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={changes.length === 0 || actions.updateMany.isPending}>
              {actions.updateMany.isPending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}
              Update {count === 1 ? '1 contact' : `${count} contacts`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
