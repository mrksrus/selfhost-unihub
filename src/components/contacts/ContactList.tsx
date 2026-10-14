import type { MouseEvent } from 'react';
import { Check, Star } from 'lucide-react';
import { contactEmails, contactInitials, contactName, contactPhones, type Contact } from '@/lib/contacts-api';
import { contactLetter, type ContactView, type Duplicates } from '@/lib/contact-views';
import { cn } from '@/lib/utils';

interface RowProps {
  contact: Contact;
  active: boolean;
  selected: boolean;
  onOpen: (event: MouseEvent) => void;
  onToggleSelect: () => void;
  onToggleFavorite: () => void;
}

function ContactRow({ contact, active, selected, onOpen, onToggleSelect, onToggleFavorite }: RowProps) {
  const name = contactName(contact);
  const secondary = [contact.company, contactEmails(contact)[0] || contactPhones(contact)[0]].filter(Boolean).join(' · ');
  return (
    <li className={cn('group flex items-center gap-3 rounded-md pl-1 pr-1 transition-colors', selected ? 'bg-accent/10' : active ? 'bg-muted' : 'hover:bg-muted/50')}>
      {/* The avatar is the selection toggle, so rows stay one tap to open; with a mouse, Ctrl/Cmd+click and Shift+click on the row select too. */}
      <button type="button" onClick={onToggleSelect} aria-pressed={selected} aria-label={`Select ${name}`}
        className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground group-hover:bg-background')}>
        {selected ? <Check aria-hidden="true" className="h-4 w-4" /> : contactInitials(contact)}
      </button>
      <button type="button" onClick={onOpen} onMouseDown={event => { if (event.shiftKey) event.preventDefault(); }} aria-current={active ? 'true' : undefined}
        className="min-w-0 flex-1 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="block truncate text-sm font-medium">{name}</span>
        {secondary && <span className="block truncate text-xs text-muted-foreground">{secondary}</span>}
      </button>
      <button type="button" onClick={onToggleFavorite} aria-pressed={contact.is_favorite}
        aria-label={contact.is_favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          contact.is_favorite ? 'text-warning' : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100')}>
        <Star aria-hidden="true" className={cn('h-4 w-4', contact.is_favorite && 'fill-current')} />
      </button>
    </li>
  );
}

interface ListProps {
  contacts: Contact[];
  view: ContactView;
  duplicates: Duplicates;
  activeId: string | null;
  selectedIds: Set<string>;
  onOpen: (contact: Contact, event: MouseEvent) => void;
  onToggleSelect: (contact: Contact) => void;
  onToggleFavorite: (contact: Contact) => void;
}

/** Contacts as rows, under letter headings (or duplicate groups). */
export function ContactList({ contacts, view, duplicates, activeId, selectedIds, onOpen, onToggleSelect, onToggleFavorite }: ListProps) {
  const sections: { key: string; label: string | null; contacts: Contact[] }[] = [];
  for (const contact of contacts) {
    const key = view === 'duplicates' ? duplicates.get(contact.id)?.key ?? '' : contactLetter(contact);
    const last = sections[sections.length - 1];
    if (last?.key === key) last.contacts.push(contact);
    else sections.push({ key, label: view === 'duplicates' ? null : key, contacts: [contact] });
  }

  return (
    <div className={view === 'duplicates' ? 'space-y-4' : 'space-y-3'}>
      {sections.map(section => (
        <section key={section.key} aria-label={section.label ?? `Group of ${section.contacts.length}`}
          className={view === 'duplicates' ? 'rounded-lg border border-border p-1' : undefined}>
          {section.label && <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{section.label}</h2>}
          <ul>
            {section.contacts.map(contact => (
              <ContactRow key={contact.id} contact={contact} active={contact.id === activeId} selected={selectedIds.has(contact.id)}
                onOpen={event => onOpen(contact, event)} onToggleSelect={() => onToggleSelect(contact)} onToggleFavorite={() => onToggleFavorite(contact)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
