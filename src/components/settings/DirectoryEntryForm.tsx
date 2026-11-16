import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { DirectoryEntry, DirectoryEntryInput } from '@/lib/directory-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsBlock, SettingsRow } from '@/components/settings/SettingsLayout';

const FIELDS = [
  { key: 'phone', label: 'Phone', max: 64, autoComplete: 'tel' },
  { key: 'job_title', label: 'Job title', max: 255, autoComplete: 'organization-title' },
  { key: 'department', label: 'Department', max: 255, autoComplete: 'off' },
] as const;
type Entry = Pick<DirectoryEntry, 'phone' | 'job_title' | 'department'>;
const valuesOf = (entry: Entry) => ({ phone: entry.phone ?? '', job_title: entry.job_title ?? '', department: entry.department ?? '' });

/**
 * The three fields a person adds to their company directory entry, for
 * their own Settings › Profile and for an administrator's correction. Only
 * the fields that were changed are sent.
 */
export function DirectoryEntryForm({ id, entry, pending, saveLabel, onSave }: {
  id: string; entry: Entry; pending: boolean; saveLabel: string; onSave: (input: DirectoryEntryInput) => void;
}) {
  const [values, setValues] = useState(() => valuesOf(entry));
  useEffect(() => { setValues(valuesOf(entry)); }, [entry.phone, entry.job_title, entry.department]); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = valuesOf(entry);
  const changed = FIELDS.filter(field => values[field.key].trim() !== saved[field.key]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed.length && !pending) onSave(Object.fromEntries(changed.map(field => [field.key, values[field.key].trim() || null])));
  };
  return (
    <form onSubmit={submit} className="divide-y divide-border">
      {FIELDS.map(field => (
        <SettingsRow key={field.key} label={field.label} htmlFor={`${id}-${field.key}`}>
          <Input id={`${id}-${field.key}`} className="w-full sm:w-64" maxLength={field.max} autoComplete={field.autoComplete} type={field.key === 'phone' ? 'tel' : 'text'}
            value={values[field.key]} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} />
        </SettingsRow>
      ))}
      <SettingsBlock className="flex justify-end">
        <Button type="submit" disabled={!changed.length || pending}>{pending && <Loader2 aria-hidden="true" className="animate-spin" />}{saveLabel}</Button>
      </SettingsBlock>
    </form>
  );
}
