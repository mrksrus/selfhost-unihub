import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { ContactVersionConflict, type Contact } from '@/lib/contacts-api';
import type { ContactActions } from '@/hooks/use-contact-actions';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useFocusAfterAdd } from '@/hooks/use-focus-after-add';
import { AddressRows, DateField, Field, PhotoField, ValueRows } from '@/components/contacts/ContactEditorFields';
import {
  emptyAddress, emptyForm, emptyValue, formForNew, formOf, OPTIONAL_FIELDS, toInput, validate, type ContactForm, type OptionalField,
} from '@/components/contacts/contact-editor-form';

export type ContactEditorTarget = { kind: 'new'; name?: string; email?: string } | { kind: 'edit'; contact: Contact } | null;

const NEW_CONTACT: Pick<Contact, 'id' | 'photo' | 'display_name' | 'name' | 'emails' | 'phones'> = {
  id: '', photo: null, display_name: '', name: { display: null, given: null, family: null, middle: null, prefix: null, suffix: null }, emails: [], phones: [],
};

/** Where "Add field" puts the focus for each section it shows. */
const FIRST_INPUT: Record<OptionalField, string> = {
  name_details: 'contact-prefix', nicknames: 'contact-nicknames', department: 'contact-department', addresses: '', birthday: 'contact-birthday',
  anniversary: 'contact-anniversary', urls: 'contact-urls', impp: 'contact-impp', related: 'contact-related', categories: 'contact-categories',
};

/**
 * The contact editor: a dialog on wide windows, the whole screen on phones.
 * Phones, emails, company, title and notes are always there; the other vCard
 * fields appear from "Add field" or when the contact holds them. A contact
 * changed elsewhere since it was opened is not overwritten silently.
 */
export function ContactEditor({ target, onClose, actions, onSaved }: {
  target: ContactEditorTarget; onClose: () => void; actions: ContactActions; onSaved?: (id: string) => void;
}) {
  const isMobile = useIsMobile();
  const [form, setForm] = useState<ContactForm>(emptyForm);
  const [errors, setErrors] = useState<ReturnType<typeof validate>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Contact | null>(null);
  const [photoStatus, setPhotoStatus] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The contact as last saved here: a save whose picture then failed leaves the editor open on it,
  // and the next save updates it (its version, its value ids) instead of adding it again.
  const [saved, setSaved] = useState<Contact | null>(null);
  const editing = saved ?? (target?.kind === 'edit' ? target.contact : null);
  const clearFocus = useCallback(() => setFocusId(null), []);
  useFocusAfterAdd(focusId, clearFocus);

  useEffect(() => {
    if (!target) return;
    setForm(target.kind === 'edit' ? formOf(target.contact) : formForNew(target.name, target.email));
    setErrors({}); setSaveError(null); setConflict(null); setPhotoStatus(null); setPhotoError(null); setSaved(null);
  }, [target]);

  const set = <K extends keyof ContactForm>(key: K, value: ContactForm[K]) => setForm(prev => ({ ...prev, [key]: value }));
  const show = (field: OptionalField) => {
    setForm(prev => {
      const next = { ...prev, shown: prev.shown.includes(field) ? prev.shown : [...prev.shown, field] };
      if (field === 'addresses' && !next.addresses.length) next.addresses = [emptyAddress()];
      for (const kind of ['nicknames', 'urls', 'impp', 'related'] as const) if (field === kind && !next[kind].length) next[kind] = [emptyValue(kind === 'nicknames' ? 'short_name' : kind === 'urls' ? 'homepage' : 'home')];
      if (field === 'addresses') setFocusId(`contact-address-${next.addresses[0].key}-street`);
      else setFocusId(FIRST_INPUT[field]);
      return next;
    });
  };
  const hide = (field: OptionalField) => setForm(prev => {
    const next: ContactForm = { ...prev, shown: prev.shown.filter(entry => entry !== field) };
    if (field === 'birthday' || field === 'anniversary') next[field] = { year: '', month: '', day: '' };
    if (field === 'categories') next.categories = '';
    if (field === 'department') next.department = '';
    if (field === 'name_details') Object.assign(next, { middle: '', prefix: '', suffix: '', display: '' });
    return next;
  });
  const shown = (field: OptionalField) => form.shown.includes(field);
  const hidden = OPTIONAL_FIELDS.filter(field => !shown(field.id));

  const finishPhoto = async (id: string, before: Contact | null) => {
    if (form.photo.kind === 'file') {
      setPhotoStatus('Converting…');
      try { await actions.setPhoto.mutateAsync({ id, file: form.photo.file }); }
      catch (error) {
        setPhotoStatus(null);
        setPhotoError(error instanceof Error ? error.message : 'The picture could not be saved.');
        return false;
      }
    } else if (form.photo.kind === 'remove' && before?.photo) {
      setPhotoStatus('Removing…');
      try { await actions.removePhoto.mutateAsync(id); }
      catch (error) {
        setPhotoStatus(null);
        setPhotoError(error instanceof Error ? error.message : 'The photo could not be removed.');
        return false;
      }
    }
    setPhotoStatus(null);
    return true;
  };

  const save = async (version: number | undefined) => {
    setBusy(true); setSaveError(null); setConflict(null);
    try {
      const result = editing
        ? await actions.update.mutateAsync({ id: editing.id, contact: toInput(form, version ?? editing.version) })
        : await actions.create.mutateAsync(toInput(form));
      // The contact is saved before its picture; a failed picture leaves the editor open on the saved contact.
      if (!(await finishPhoto(result.id, editing))) {
        setSaved(result);
        setForm({ ...formOf(result), shown: [...new Set([...formOf(result).shown, ...form.shown])] });
        onSaved?.(result.id);
        return;
      }
      onSaved?.(result.id);
      onClose();
    } catch (error) {
      if (error instanceof ContactVersionConflict) setConflict(error.current);
      else setSaveError(error instanceof Error ? error.message : 'The contact could not be saved.');
      // The hook's notice names the failure too; the inline text keeps it next to the fields after the notice is gone.
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems = validate(form);
    setErrors(problems);
    if (Object.keys(problems).length) return;
    void save(undefined);
  };

  const title = editing ? 'Edit contact' : 'New contact';
  const saveLabel = editing ? 'Save' : 'Add contact';
  const pending = busy || !!photoStatus;

  const addField = hidden.length > 0 && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm"><Plus aria-hidden="true" />Add field</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {hidden.map(field => <DropdownMenuItem key={field.id} onClick={() => show(field.id)}>{field.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const fields = (
    <div className="space-y-6">
      <PhotoField contact={editing ?? NEW_CONTACT} photo={form.photo} onChange={photo => { setPhotoError(null); set('photo', photo); }} status={photoStatus} error={photoError} />

      <div className="space-y-3">
        {shown('name_details') && (
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Field id="contact-prefix" label="Title"><Input id="contact-prefix" value={form.prefix} placeholder="Dr." onChange={event => set('prefix', event.target.value)} /></Field>
            <Button type="button" variant="ghost" size="icon-sm" className="mt-7 text-muted-foreground" aria-label="Remove name details" onClick={() => hide('name_details')}><X aria-hidden="true" /></Button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field id="contact-first-name" label="First name">
            <Input id="contact-first-name" value={form.given} autoFocus={!editing && !isMobile} autoComplete="off" onChange={event => set('given', event.target.value)} />
          </Field>
          <Field id="contact-last-name" label="Last name">
            <Input id="contact-last-name" value={form.family} autoComplete="off" onChange={event => set('family', event.target.value)} />
          </Field>
        </div>
        {shown('name_details') && (
          <div className="grid grid-cols-2 gap-3">
            <Field id="contact-middle-name" label="Middle name"><Input id="contact-middle-name" value={form.middle} onChange={event => set('middle', event.target.value)} /></Field>
            <Field id="contact-suffix" label="Suffix"><Input id="contact-suffix" value={form.suffix} placeholder="Jr." onChange={event => set('suffix', event.target.value)} /></Field>
            <Field id="contact-display-name" label="Shown as" className="col-span-2">
              <Input id="contact-display-name" value={form.display} placeholder="Leave empty to use the name parts" onChange={event => set('display', event.target.value)} />
            </Field>
          </div>
        )}
        {errors.identity && <p role="alert" className="text-sm text-destructive">{errors.identity}</p>}
      </div>

      {shown('nicknames') && <ValueRows kind="nicknames" values={form.nicknames} onChange={values => set('nicknames', values)} keepOne={false} onAdded={setFocusId} onAllRemoved={() => hide('nicknames')} />}
      <ValueRows kind="phones" values={form.phones} onChange={values => set('phones', values)} keepOne onAdded={setFocusId} />
      <ValueRows kind="emails" values={form.emails} onChange={values => set('emails', values)} keepOne onAdded={setFocusId} />
      {errors.labels && <p role="alert" className="text-sm text-destructive">{errors.labels}</p>}

      <div className="grid grid-cols-2 gap-3">
        <Field id="contact-company" label="Company"><Input id="contact-company" value={form.company} onChange={event => set('company', event.target.value)} /></Field>
        <Field id="contact-job-title" label="Job title"><Input id="contact-job-title" value={form.job_title} onChange={event => set('job_title', event.target.value)} /></Field>
        {shown('department') && (
          <Field id="contact-department" label="Department" className="col-span-2">
            <div className="flex gap-2">
              <Input id="contact-department" value={form.department} onChange={event => set('department', event.target.value)} />
              <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 self-center text-muted-foreground" aria-label="Remove department" onClick={() => hide('department')}><X aria-hidden="true" /></Button>
            </div>
          </Field>
        )}
      </div>

      {shown('addresses') && <AddressRows addresses={form.addresses} onChange={addresses => set('addresses', addresses)} onAdded={setFocusId} onAllRemoved={() => hide('addresses')} />}
      {shown('birthday') && <DateField id="contact-birthday" label="Birthday" value={form.birthday} onChange={value => set('birthday', value)} error={errors.birthday} onRemove={() => hide('birthday')} />}
      {shown('anniversary') && <DateField id="contact-anniversary" label="Anniversary" value={form.anniversary} onChange={value => set('anniversary', value)} error={errors.anniversary} onRemove={() => hide('anniversary')} />}
      {shown('urls') && <ValueRows kind="urls" values={form.urls} onChange={values => set('urls', values)} keepOne={false} onAdded={setFocusId} onAllRemoved={() => hide('urls')} />}
      {shown('impp') && <ValueRows kind="impp" values={form.impp} onChange={values => set('impp', values)} keepOne={false} onAdded={setFocusId} onAllRemoved={() => hide('impp')} />}
      {shown('related') && <ValueRows kind="related" values={form.related} onChange={values => set('related', values)} keepOne={false} onAdded={setFocusId} onAllRemoved={() => hide('related')} />}
      {shown('categories') && (
        <Field id="contact-categories" label="Categories">
          <div className="flex gap-2">
            <Input id="contact-categories" value={form.categories} placeholder="Family, Running club" onChange={event => set('categories', event.target.value)} />
            <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 self-center text-muted-foreground" aria-label="Remove categories" onClick={() => hide('categories')}><X aria-hidden="true" /></Button>
          </div>
          <p className="text-xs text-muted-foreground">Separate with commas.</p>
        </Field>
      )}

      <Field id="contact-notes" label="Notes">
        <Textarea id="contact-notes" rows={3} value={form.notes} onChange={event => set('notes', event.target.value)} />
      </Field>

      {addField}

      {editing && editing.kept_properties > 0 && (
        <p className="text-xs text-muted-foreground">{editing.kept_properties} other details from imports stay with the contact and are not edited here.</p>
      )}
      {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
      {conflict && (
        <div role="alert" className="space-y-2 rounded-md border border-warning/60 px-3 py-2 text-sm">
          <p>This contact was changed on another device meanwhile. Your changes are not saved yet.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => { setSaved(conflict); setForm(formOf(conflict)); setConflict(null); }}>Load their version</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void save(conflict.version)}>Save mine anyway</Button>
          </div>
        </div>
      )}
    </div>
  );

  const closeUnlessBusy = (open: boolean) => { if (!open && !pending) onClose(); };

  return (
    <Dialog open={!!target} onOpenChange={closeUnlessBusy}>
      {isMobile ? (
        // The whole visible area, like the phone composer: a title bar with Close and Save, the fields scrolling beneath.
        <DialogContent hideClose className="inset-x-0 !flex w-full max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top,0px)] sm:rounded-none"
          style={{ top: 'var(--visible-top, 0px)', height: 'var(--visible-height, 100dvh)', maxHeight: 'var(--visible-height, 100dvh)' }}>
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="flex h-12 shrink-0 flex-row items-center gap-1 space-y-0 border-b border-border pl-1 pr-2 text-left">
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Close" disabled={pending}><X aria-hidden="true" /></Button>
              </DialogClose>
              <DialogTitle className="min-w-0 flex-1 truncate text-base leading-tight">{title}</DialogTitle>
              <DialogDescription className="sr-only">Contact fields</DialogDescription>
              <Button type="submit" size="sm" disabled={pending}>
                {pending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}{saveLabel}
              </Button>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">{fields}</div>
          </form>
        </DialogContent>
      ) : (
        <DialogContent className="flex max-h-[90dvh] flex-col gap-0 p-0 sm:max-w-2xl">
          <DialogHeader className="px-6 pb-3 pt-6">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">Contact fields</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">{fields}</div>
            <DialogFooter className="gap-2 border-t border-border px-6 py-4 sm:gap-0">
              <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}{saveLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
