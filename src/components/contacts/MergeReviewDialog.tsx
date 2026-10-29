import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Contact, ContactSingleField, DuplicateGroup, LabelledValue } from '@/lib/contacts-api';
import { addressLines, formatPartialDate, labelText, SINGLE_FIELD_TEXT } from '@/lib/contact-fields';
import type { ContactActions } from '@/hooks/use-contact-actions';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Chip, ChipGroup } from '@/components/ui/chips';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContactAvatar } from '@/components/contacts/ContactAvatar';

const SINGLE_FIELDS: ContactSingleField[] = ['photo', 'name', 'organization', 'department', 'job_title', 'birthday', 'anniversary'];

/** The text a single-value field shows for one contact; '' when it is empty. */
function singleValue(contact: Contact, field: ContactSingleField) {
  switch (field) {
    case 'name': return contact.display_name;
    case 'display_name': return contact.name.display || '';
    case 'organization': return contact.organization.name || '';
    case 'department': return contact.organization.department || '';
    case 'job_title': return contact.job_title || '';
    case 'birthday': return formatPartialDate(contact.birthday);
    case 'anniversary': return formatPartialDate(contact.anniversary);
    case 'photo': return contact.photo ? 'Photo' : '';
  }
}

type ListKey = 'phones' | 'emails' | 'addresses' | 'urls' | 'impp' | 'related' | 'nicknames';
const LISTS: { key: ListKey; title: string }[] = [
  { key: 'phones', title: 'Phone numbers' }, { key: 'emails', title: 'Email addresses' }, { key: 'addresses', title: 'Addresses' },
  { key: 'urls', title: 'Websites' }, { key: 'impp', title: 'Messaging' }, { key: 'related', title: 'Related people' }, { key: 'nicknames', title: 'Nicknames' },
];

const valueKey = (key: ListKey, entry: LabelledValue) => key === 'emails' ? entry.value.trim().toLowerCase()
  : key === 'phones' ? entry.value.replace(/[^\d+]/g, '') : entry.value.trim().toLowerCase();

/** Every value of every member, once; an equal value keeps the first contact's label. */
function unionOf(members: Contact[], key: ListKey) {
  const seen = new Map<string, { entry: LabelledValue; from: string[] }>();
  for (const member of members) {
    for (const entry of member[key] as LabelledValue[]) {
      if (!entry.value.trim()) continue;
      const id = valueKey(key, entry);
      const known = seen.get(id);
      if (known) known.from.push(member.display_name);
      else seen.set(id, { entry, from: [member.display_name] });
    }
  }
  return [...seen.values()];
}

const displayOf = (key: ListKey, entry: LabelledValue) => key === 'addresses' ? addressLines(entry as Contact['addresses'][number]).join(', ') : entry.value.trim();

/**
 * One contact out of several: every list value is kept and shown, so nothing
 * can be unticked; the single-value fields that differ are chosen here. Wide
 * windows put the contacts side by side with the result; phones stack them.
 */
export function MergeReviewDialog({ group, contacts, onClose, actions, onMerged }: {
  group: DuplicateGroup | null; contacts: Contact[]; onClose: () => void; actions: ContactActions; onMerged?: () => void;
}) {
  const isMobile = useIsMobile();
  const members = useMemo(() => group ? group.members.map(member => contacts.find(contact => contact.id === member.id)).filter((contact): contact is Contact => !!contact) : [], [group, contacts]);
  const missing = group ? group.members.length - members.length : 0;
  const [choices, setChoices] = useState<Partial<Record<ContactSingleField, string>>>({});
  useEffect(() => { setChoices({}); }, [group?.id]);

  // A field with two different non-empty values needs a choice; the server lists them too, this covers a list it does not know yet.
  const conflicts = useMemo(() => {
    const fields = new Set<ContactSingleField>(group?.conflicts ?? []);
    for (const field of SINGLE_FIELDS) {
      const values = new Set(members.map(member => singleValue(member, field)).filter(Boolean));
      if (values.size > 1) fields.add(field);
    }
    return SINGLE_FIELDS.filter(field => fields.has(field));
  }, [group, members]);
  const unresolved = conflicts.filter(field => !choices[field]);
  const result = (field: ContactSingleField) => {
    const chosen = choices[field] ? members.find(member => member.id === choices[field]) : undefined;
    return chosen ? singleValue(chosen, field) : conflicts.includes(field) ? '' : members.map(member => singleValue(member, field)).find(Boolean) || '';
  };
  const stacked = isMobile || members.length > 3;

  const merge = () => {
    if (!group || unresolved.length) return;
    actions.merge.mutate({
      contact_ids: group.members.map(member => member.id),
      survivor_id: choices.name ?? members[0]?.id,
      choices,
      versions: Object.fromEntries(group.members.map(member => [member.id, member.version])),
    }, { onSuccess: () => { onMerged?.(); onClose(); } });
  };
  const keepApart = () => {
    if (!group) return;
    actions.dismissDuplicates.mutate(group.members.map(member => member.id), { onSuccess: onClose });
  };
  const pending = actions.merge.isPending || actions.dismissDuplicates.isPending;

  const choiceRow = (field: ContactSingleField) => {
    const label = SINGLE_FIELD_TEXT[field];
    const options = members.filter(member => singleValue(member, field));
    return (
      <div key={field} className="space-y-1.5">
        <ChipGroup label={`${label} to keep`}>
          {options.map(member => (
            <Chip key={member.id} selected={choices[field] === member.id} onSelect={() => setChoices(prev => ({ ...prev, [field]: member.id }))}>
              {field === 'photo' ? `Photo of ${member.display_name}` : singleValue(member, field)}
            </Chip>
          ))}
        </ChipGroup>
        {!choices[field] && <p className="text-xs text-warning">Choose the {label.toLowerCase()} to keep.</p>}
      </div>
    );
  };

  const stackedBody = (
    <div className="space-y-5">
      <ul className="space-y-2">
        {members.map(member => (
          <li key={member.id} className="flex items-center gap-3">
            <ContactAvatar contact={member} />
            <span className="min-w-0 text-sm">
              <span className="block truncate font-medium">{member.display_name || 'No name'}</span>
              <span className="block truncate text-xs text-muted-foreground">{[member.organization.name, member.phones[0]?.value || member.emails[0]?.value].filter(Boolean).join(' · ')}</span>
            </span>
          </li>
        ))}
      </ul>
      {conflicts.length > 0 && (
        <section aria-label="Your choice" className="space-y-4">
          <h3 className="text-sm font-medium">Differences, choose one each</h3>
          {conflicts.map(choiceRow)}
        </section>
      )}
    </div>
  );

  const columns = `minmax(6rem,8rem) repeat(${members.length}, minmax(0,1fr)) minmax(0,1fr)`;
  const sideBySide = (
    <div role="table" aria-label="Contacts side by side" className="text-sm">
      <div role="row" className="grid items-end gap-x-3 border-b border-border pb-2" style={{ gridTemplateColumns: columns }}>
        <span role="columnheader" className="sr-only">Field</span>
        {members.map(member => (
          <span key={member.id} role="columnheader" className="flex min-w-0 items-center gap-2">
            <ContactAvatar contact={member} />
            <span className="truncate font-medium">{member.display_name || 'No name'}</span>
          </span>
        ))}
        <span role="columnheader" className="font-medium text-accent">Result</span>
      </div>
      {SINGLE_FIELDS.filter(field => members.some(member => singleValue(member, field))).map(field => {
        const conflict = conflicts.includes(field);
        return (
          <div key={field} role="row" className="grid gap-x-3 border-b border-border py-2" style={{ gridTemplateColumns: columns }}>
            <span role="rowheader" className="text-xs text-muted-foreground">{SINGLE_FIELD_TEXT[field]}</span>
            {members.map(member => {
              const value = singleValue(member, field);
              const id = `merge-${field}-${member.id}`;
              return (
                <span key={member.id} role="cell" className="min-w-0">
                  {conflict && value ? (
                    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-2">
                      <input id={id} type="radio" name={`merge-${field}`} className="h-4 w-4 shrink-0 accent-accent" checked={choices[field] === member.id}
                        onChange={() => setChoices(prev => ({ ...prev, [field]: member.id }))} />
                      <span className="break-words">{value}</span>
                    </label>
                  ) : <span className={cn('block break-words py-1', !value && 'text-muted-foreground')}>{value || '—'}</span>}
                </span>
              );
            })}
            <span role="cell" className={cn('break-words py-1', conflict && !choices[field] ? 'text-warning' : 'font-medium')}>
              {result(field) || (conflict ? 'Choose one' : '—')}
            </span>
          </div>
        );
      })}
    </div>
  );

  const kept = LISTS.map(list => ({ ...list, values: unionOf(members, list.key) })).filter(list => list.values.length);
  const categories = [...new Set(members.flatMap(member => member.categories))];
  const notes = [...new Set(members.map(member => (member.notes || '').trim()).filter(Boolean))];

  return (
    <Dialog open={!!group} onOpenChange={open => { if (!open && !pending) onClose(); }}>
      <DialogContent className={cn('flex max-h-[90dvh] flex-col gap-0 p-0', stacked ? 'sm:max-w-lg' : 'sm:max-w-4xl')}>
        <DialogHeader className="px-6 pb-3 pt-6">
          <DialogTitle>Merge {group?.members.length ?? 0} contacts into one</DialogTitle>
          <DialogDescription>Every number, email and other value is kept. Where one value must be chosen, pick it below.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-2">
          {missing > 0 && <p className="text-sm text-warning">{missing} of these contacts could not be shown; reload the page before merging.</p>}
          {stacked ? stackedBody : sideBySide}
          {kept.length > 0 && (
            <section aria-label="Kept from all contacts" className="space-y-3">
              <h3 className="text-sm font-medium">Kept from all contacts</h3>
              {kept.map(list => (
                <div key={list.key}>
                  <h4 className="mb-0.5 text-xs text-muted-foreground">{list.title}</h4>
                  <ul className="text-sm">
                    {list.values.map(({ entry, from }, index) => (
                      <li key={entry.id ?? index} className="flex flex-wrap items-baseline gap-x-2 py-0.5">
                        <span className="break-all">{displayOf(list.key, entry)}</span>
                        <span className="text-xs text-muted-foreground">{[labelText(entry), from.length > 1 ? 'in both' : from[0]].filter(Boolean).join(' · ')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {categories.length > 0 && <p className="text-sm"><span className="text-xs text-muted-foreground">Categories </span>{categories.join(', ')}</p>}
              {notes.length > 1 && <p className="text-xs text-muted-foreground">The {notes.length} notes are kept one after the other.</p>}
            </section>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 border-t border-border px-6 py-4 sm:flex-row sm:justify-between sm:gap-2">
          <div className="flex flex-wrap gap-2 touch:gap-3">
            <Button type="button" variant="outline" onClick={keepApart} disabled={pending}>Not the same person</Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Skip</Button>
          </div>
          <Button type="button" onClick={merge} disabled={pending || unresolved.length > 0 || members.length < 2 || missing > 0}
            title={unresolved.length ? `Choose the ${unresolved.map(field => SINGLE_FIELD_TEXT[field].toLowerCase()).join(', ')} first` : undefined}>
            {actions.merge.isPending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
