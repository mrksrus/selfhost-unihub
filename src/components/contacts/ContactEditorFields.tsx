import { useEffect, useRef, type ReactNode } from 'react';
import { Camera, Plus, Star, X } from 'lucide-react';
import { LABELS, LIST_KINDS, labelText, type ListKind } from '@/lib/contact-fields';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ContactAvatar } from '@/components/contacts/ContactAvatar';
import { emptyAddress, emptyValue, type AddressDraft, type ContactForm, type DateDraft, type ValueDraft } from '@/components/contacts/contact-editor-form';
import type { Contact } from '@/lib/contacts-api';

function LabelPicker({ kind, value, onChange, ariaLabel }: { kind: ListKind | 'addresses'; value: string; onChange: (label: string) => void; ariaLabel: string }) {
  // A value without label (from before 0.26) keeps that choice until the person picks one; the select needs a word for it.
  const NONE = 'none';
  const choices = value === '' ? ['', ...LABELS[kind]] : LABELS[kind];
  return (
    <Select value={value || NONE} onValueChange={label => onChange(label === NONE ? '' : label)}>
      <SelectTrigger aria-label={ariaLabel} className="h-10 w-[7.5rem] shrink-0 sm:w-36">
        <SelectValue placeholder="Label">{labelText({ label: value, custom_label: null }, 'No label')}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {choices.map(label => <SelectItem key={label || NONE} value={label || NONE}>{label ? labelText({ label, custom_label: null }) : 'No label'}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** The star that marks the preferred value of a kind, and the remove cross, with a touch gap between them. */
function RowControls({ what, preferred, onPreferred, onRemove, removable }: { what: string; preferred: boolean; onPreferred: () => void; onRemove: () => void; removable: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 touch:gap-2">
      <Button type="button" variant="ghost" size="icon-sm" aria-pressed={preferred} aria-label={`Preferred ${what}`} onClick={onPreferred}
        className={cn(preferred ? 'text-warning' : 'text-muted-foreground')}>
        <Star aria-hidden="true" className={cn(preferred && 'fill-current')} />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${what}`} onClick={onRemove} disabled={!removable} className="text-muted-foreground">
        <X aria-hidden="true" />
      </Button>
    </span>
  );
}

interface ValueRowsProps {
  kind: ListKind;
  values: ValueDraft[];
  onChange: (values: ValueDraft[]) => void;
  /** Phones and emails keep one empty row; the optional kinds disappear when their last row goes. */
  keepOne: boolean;
  onAdded?: (inputId: string) => void;
  onAllRemoved?: () => void;
}

/** Repeatable labelled values of one kind: label, value, preferred star, remove. */
export function ValueRows({ kind, values, onChange, keepOne, onAdded, onAllRemoved }: ValueRowsProps) {
  const text = LIST_KINDS[kind];
  const inputId = (entry: ValueDraft) => `contact-${kind}-${entry.key}`;
  const update = (key: string, patch: Partial<ValueDraft>) => onChange(values.map(entry => entry.key === key ? { ...entry, ...patch } : entry));
  const setPreferred = (key: string) => onChange(values.map(entry => ({ ...entry, preferred: entry.key === key ? !entry.preferred : false })));
  const remove = (key: string) => {
    const rest = values.filter(entry => entry.key !== key);
    if (!rest.length && keepOne) return onChange([emptyValue()]);
    onChange(rest);
    if (!rest.length) onAllRemoved?.();
  };
  const add = () => {
    const entry = emptyValue(kind === 'phones' ? 'mobile' : kind === 'emails' ? 'home' : LABELS[kind][0]);
    onChange([...values, entry]);
    onAdded?.(inputId(entry));
  };
  const what = (index: number) => values.length > 1 ? `${text.singular.toLowerCase()} ${index + 1}` : text.singular.toLowerCase();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{text.singular}</legend>
      {values.map((entry, index) => (
        <div key={entry.key} className="space-y-2">
          <div className="flex items-center gap-2">
            <LabelPicker kind={kind} value={entry.label} ariaLabel={`Label of ${what(index)}`} onChange={label => update(entry.key, { label })} />
            <Input id={index === 0 ? `contact-${kind}` : inputId(entry)} type={text.inputType} value={entry.value} placeholder={text.placeholder}
              aria-label={index === 0 ? text.singular : `${text.singular} ${index + 1}`} autoComplete="off"
              onChange={event => update(entry.key, { value: event.target.value })} />
            <RowControls what={what(index)} preferred={entry.preferred} onPreferred={() => setPreferred(entry.key)} onRemove={() => remove(entry.key)}
              removable={!keepOne || values.length > 1 || !!entry.value} />
          </div>
          {entry.label === 'custom' && (
            <Input value={entry.custom_label} placeholder="Custom label" aria-label={`Custom label of ${what(index)}`} className="ml-0 sm:ml-[9.5rem] sm:w-[calc(100%-9.5rem)]"
              onChange={event => update(entry.key, { custom_label: event.target.value })} />
          )}
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={add}>
        <Plus aria-hidden="true" />{text.add}
      </Button>
    </fieldset>
  );
}

const ADDRESS_PARTS: { key: keyof Omit<AddressDraft, 'key' | 'id' | 'label' | 'custom_label' | 'preferred'>; label: string; wide?: boolean }[] = [
  { key: 'street', label: 'Street', wide: true },
  { key: 'extended', label: 'Apartment, floor', wide: true },
  { key: 'postal_code', label: 'Postal code' },
  { key: 'locality', label: 'City' },
  { key: 'region', label: 'Region' },
  { key: 'country', label: 'Country' },
  { key: 'po_box', label: 'PO box' },
];

/** Structured postal addresses, each with a label and the preferred star. */
export function AddressRows({ addresses, onChange, onAdded, onAllRemoved }: {
  addresses: AddressDraft[]; onChange: (addresses: AddressDraft[]) => void; onAdded?: (inputId: string) => void; onAllRemoved?: () => void;
}) {
  const update = (key: string, patch: Partial<AddressDraft>) => onChange(addresses.map(entry => entry.key === key ? { ...entry, ...patch } : entry));
  const remove = (key: string) => {
    const rest = addresses.filter(entry => entry.key !== key);
    onChange(rest);
    if (!rest.length) onAllRemoved?.();
  };
  const add = () => {
    const entry = emptyAddress();
    onChange([...addresses, entry]);
    onAdded?.(`contact-address-${entry.key}-street`);
  };
  return (
    <fieldset className="space-y-4">
      <legend className="mb-2 text-sm font-medium">Address</legend>
      {addresses.map((address, index) => {
        const what = addresses.length > 1 ? `address ${index + 1}` : 'address';
        return (
          <div key={address.key} className="space-y-2 border-l-2 border-border pl-3">
            <div className="flex items-center gap-2">
              <LabelPicker kind="addresses" value={address.label} ariaLabel={`Label of ${what}`} onChange={label => update(address.key, { label })} />
              {address.label === 'custom' && (
                <Input value={address.custom_label} placeholder="Custom label" aria-label={`Custom label of ${what}`} onChange={event => update(address.key, { custom_label: event.target.value })} />
              )}
              <span className="ml-auto">
                <RowControls what={what} preferred={address.preferred} removable
                  onPreferred={() => onChange(addresses.map(entry => ({ ...entry, preferred: entry.key === address.key ? !entry.preferred : false })))}
                  onRemove={() => remove(address.key)} />
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {ADDRESS_PARTS.map(part => (
                <Input key={part.key} id={`contact-address-${address.key}-${part.key}`} value={address[part.key]} placeholder={part.label}
                  aria-label={addresses.length > 1 ? `${part.label} of ${what}` : part.label} className={part.wide ? 'col-span-2' : undefined}
                  onChange={event => update(address.key, { [part.key]: event.target.value })} />
              ))}
            </div>
          </div>
        );
      })}
      <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={add}>
        <Plus aria-hidden="true" />Add another address
      </Button>
    </fieldset>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A birthday or anniversary: month, day and an optional year. */
export function DateField({ id, label, value, onChange, error, onRemove }: {
  id: string; label: string; value: DateDraft; onChange: (value: DateDraft) => void; error?: string; onRemove: () => void;
}) {
  return (
    <fieldset className="space-y-2" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="flex items-center gap-2">
        <Select value={value.month} onValueChange={month => onChange({ ...value, month })}>
          <SelectTrigger id={id} aria-label={`${label} month`} className="h-10 w-[7.5rem] shrink-0 sm:w-36"><SelectValue placeholder="Month" /></SelectTrigger>
          <SelectContent>
            {MONTHS.map((name, index) => <SelectItem key={name} value={String(index + 1)}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input inputMode="numeric" value={value.day} placeholder="Day" aria-label={`${label} day`} className="w-16" onChange={event => onChange({ ...value, day: event.target.value })} />
        <Input inputMode="numeric" value={value.year} placeholder="Year" aria-label={`${label} year (optional)`} className="w-20" onChange={event => onChange({ ...value, year: event.target.value })} />
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${label.toLowerCase()}`} onClick={onRemove} className="ml-auto text-muted-foreground"><X aria-hidden="true" /></Button>
      </div>
      <p id={error ? `${id}-error` : undefined} className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>{error ?? 'Leave the year empty when it is unknown.'}</p>
    </fieldset>
  );
}

/** The photo: choose a picture or remove it. No cropping; the server resizes and converts it. */
export function PhotoField({ contact, photo, onChange, status, error }: {
  contact: Pick<Contact, 'id' | 'photo' | 'display_name' | 'name' | 'emails' | 'phones'>;
  photo: ContactForm['photo'];
  onChange: (photo: ContactForm['photo']) => void;
  status?: string | null;
  error?: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const preview = photo.kind === 'file' ? photo.url : photo.kind === 'remove' ? '' : null;
  const hasPhoto = photo.kind === 'file' || (photo.kind === 'keep' && !!contact.photo);
  // The object URL of a chosen file is released when it is replaced or the editor closes.
  useEffect(() => () => { if (photo.kind === 'file') URL.revokeObjectURL(photo.url); }, [photo]);
  const choose = (file: File | undefined) => {
    if (!file) return;
    onChange({ kind: 'file', file, url: URL.createObjectURL(file) });
  };
  return (
    <div className="flex items-center gap-4">
      <ContactAvatar contact={contact} size="editor" src={preview} />
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={!!status}>
            <Camera aria-hidden="true" />{hasPhoto ? 'Change photo' : 'Choose photo'}
          </Button>
          {hasPhoto && <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ kind: 'remove' })} disabled={!!status}>Remove</Button>}
          <input ref={input} type="file" accept="image/*" className="hidden" aria-label="Choose photo"
            onChange={event => { choose(event.target.files?.[0]); event.target.value = ''; }} />
        </div>
        <p className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')} role={error ? 'alert' : undefined}>
          {error ?? status ?? 'JPEG, PNG, WebP, HEIC, AVIF or GIF. It is resized by the server, no cropping needed.'}
        </p>
      </div>
    </div>
  );
}

export function Field({ id, label, children, className }: { id: string; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
