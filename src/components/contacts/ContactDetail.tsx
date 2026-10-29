import { useState, type MouseEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, AtSign, Cake, ChevronDown, Copy, Globe, Mail, MapPin, MessageSquare, MoreHorizontal, Phone, Star, Users } from 'lucide-react';
import { contactDetailQueryOptions, contactName, type Address, type Contact, type KeptProperty, type LabelledValue } from '@/lib/contacts-api';
import { addressLines, contactRole, formatPartialDate, labelText, mapHref, safeHref, telHref } from '@/lib/contact-fields';
import { copyText } from '@/lib/platform';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { LoadingState } from '@/components/ui/page-states';
import { ContactAvatar } from '@/components/contacts/ContactAvatar';

interface Props {
  contact: Contact;
  /** Compose inside UniHub instead of following the mailto: link. */
  onEmail?: (address: string) => void;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
}

function CopyButton({ value }: { value: string }) {
  const { toast } = useToast();
  const copy = async () => {
    const copied = await copyText(value);
    toast(copied ? { title: 'Copied' } : { title: 'Could not copy', variant: 'destructive' });
  };
  return (
    <Button variant="ghost" size="icon-sm" className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      aria-label={`Copy ${value}`} onClick={() => void copy()}>
      <Copy aria-hidden="true" />
    </Button>
  );
}

/** One value with its label underneath; a link when it does one thing (write, call, open), text otherwise. Every row can be copied. */
function ValueRow({ href, icon, label, value, lines, onClick, trailing }: {
  href?: string | null; icon: ReactNode; label: string; value: string; lines?: string[]; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void; trailing?: ReactNode;
}) {
  const body = (
    <>
      <span aria-hidden="true" className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        {lines
          ? lines.map((line, index) => <span key={index} className={cn('block break-words text-sm', href && 'text-accent')}>{line}</span>)
          : <span className={cn('block break-words text-sm', href && 'text-accent')}>{value}</span>}
        {label && <span className="block text-xs text-muted-foreground">{label}</span>}
      </span>
    </>
  );
  const rowClass = 'flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <li className="group flex items-center gap-1 rounded-md hover:bg-muted/50">
      {href ? <a href={href} onClick={onClick} className={rowClass} rel={href.startsWith('http') ? 'noopener noreferrer' : undefined} target={href.startsWith('http') ? '_blank' : undefined}>{body}</a>
        : <div className={rowClass}>{body}</div>}
      {trailing}
      <CopyButton value={value} />
    </li>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-5">
      <h3 className="mb-0.5 px-2 text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="-mx-2">{children}</ul>
    </section>
  );
}

const withValues = <T extends LabelledValue>(list: T[]) => list.filter(entry => entry.value.trim());

function KeptProperties({ id, count }: { id: string; count: number }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({ ...contactDetailQueryOptions(id), enabled: open });
  const properties: KeptProperty[] = detail.data?.properties ?? [];
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-5">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronDown aria-hidden="true" className={cn('h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
          Other details kept from imports ({count})
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {detail.isLoading ? <LoadingState compact label="Loading details…" />
          : detail.error ? <p className="px-2 py-2 text-sm text-destructive">Could not load them: {detail.error.message}</p>
          : (
            <dl className="px-2 py-1 font-mono text-xs">
              {properties.map((property, index) => (
                <div key={index} className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 py-1">
                  <dt className="truncate text-muted-foreground">{property.group ? `${property.group}.` : ''}{property.name}</dt>
                  <dd className="min-w-0 break-all">{property.value}</dd>
                </div>
              ))}
              {!properties.length && <p className="py-1 text-muted-foreground">Nothing kept.</p>}
            </dl>
          )}
        <p className="px-2 pb-2 text-xs text-muted-foreground">Read-only. They are written back when the contact is exported.</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ContactDetail({ contact, onEmail, onBack, onEdit, onDelete, onToggleFavorite }: Props) {
  const name = contactName(contact);
  const nickname = withValues(contact.nicknames)[0]?.value.trim();
  const role = contactRole(contact);
  const phones = withValues(contact.phones);
  const emails = withValues(contact.emails);
  const addresses = contact.addresses.filter(address => addressLines(address).length);
  const urls = withValues(contact.urls);
  const impp = withValues(contact.impp);
  const related = withValues(contact.related);
  const dates = [contact.birthday && { label: 'Birthday', value: formatPartialDate(contact.birthday) }, contact.anniversary && { label: 'Anniversary', value: formatPartialDate(contact.anniversary) }]
    .filter((entry): entry is { label: string; value: string } => !!entry);
  const empty = !phones.length && !emails.length && !addresses.length && !urls.length && !impp.length && !related.length && !dates.length;

  return (
    <article aria-label={name} className="mx-auto w-full max-w-xl px-4 py-4 md:px-6">
      <div className="mb-4 flex items-center gap-1">
        <Button variant="ghost" size="sm" className="-ml-2 lg:hidden" onClick={onBack}><ArrowLeft aria-hidden="true" />Contacts</Button>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-pressed={contact.is_favorite} onClick={onToggleFavorite}
            aria-label={contact.is_favorite ? 'Remove from favorites' : 'Add to favorites'}>
            <Star aria-hidden="true" className={cn(contact.is_favorite && 'fill-current text-warning')} />
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit}>Edit</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`More actions for ${name}`}><MoreHorizontal aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>Delete contact</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-4">
        <ContactAvatar contact={contact} size="detail" />
        <div className="min-w-0">
          <h2 className="break-words text-xl font-semibold tracking-tight">
            {name}
            {nickname && <span className="font-normal text-muted-foreground"> “{nickname}”</span>}
          </h2>
          {role && <p className="text-sm text-muted-foreground">{role}</p>}
          {contact.categories.length > 0 && (
            <ul aria-label="Categories" className="mt-2 flex flex-wrap gap-1.5">
              {contact.categories.map(category => (
                <li key={category} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{category}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {empty && <p className="mb-6 text-sm text-muted-foreground">No email or phone number yet.</p>}

      {phones.length > 0 && (
        <Group title="Phone">
          {phones.map((entry, index) => (
            <ValueRow key={entry.id ?? index} href={telHref(entry.value)} icon={<Phone className="h-4 w-4" />} value={entry.value}
              label={[labelText(entry), entry.preferred ? 'preferred' : ''].filter(Boolean).join(' · ')} />
          ))}
        </Group>
      )}
      {emails.length > 0 && (
        <Group title="Email">
          {emails.map((entry, index) => (
            <ValueRow key={entry.id ?? index} href={`mailto:${entry.value.trim()}`} icon={<Mail className="h-4 w-4" />} value={entry.value.trim()}
              label={[labelText(entry), entry.preferred ? 'preferred' : ''].filter(Boolean).join(' · ')}
              onClick={onEmail ? (event) => { event.preventDefault(); onEmail(entry.value.trim()); } : undefined} />
          ))}
        </Group>
      )}
      {addresses.length > 0 && (
        <Group title="Addresses">
          {addresses.map((address: Address, index) => (
            <ValueRow key={address.id ?? index} icon={<MapPin className="h-4 w-4" />} value={addressLines(address).join(', ')} lines={addressLines(address)} label={labelText(address)}
              trailing={<Button asChild variant="ghost" size="sm" className="shrink-0 text-muted-foreground"><a href={mapHref(address)}>Map</a></Button>} />
          ))}
        </Group>
      )}
      {dates.length > 0 && (
        <Group title="Dates">
          {dates.map(entry => <ValueRow key={entry.label} icon={<Cake className="h-4 w-4" />} value={entry.value} label={entry.label} />)}
        </Group>
      )}
      {urls.length > 0 && (
        <Group title="Web">
          {urls.map((entry, index) => <ValueRow key={entry.id ?? index} href={safeHref(entry.value)} icon={<Globe className="h-4 w-4" />} value={entry.value.trim()} label={labelText(entry)} />)}
        </Group>
      )}
      {impp.length > 0 && (
        <Group title="Messaging">
          {impp.map((entry, index) => <ValueRow key={entry.id ?? index} href={safeHref(entry.value)} icon={<MessageSquare className="h-4 w-4" />} value={entry.value.trim()} label={labelText(entry)} />)}
        </Group>
      )}
      {related.length > 0 && (
        <Group title="Related people">
          {related.map((entry, index) => <ValueRow key={entry.id ?? index} icon={<Users className="h-4 w-4" />} value={entry.value.trim()} label={labelText(entry)} />)}
        </Group>
      )}
      {contact.nicknames.length > 1 && (
        <Group title="Also known as">
          {withValues(contact.nicknames).slice(1).map((entry, index) => <ValueRow key={entry.id ?? index} icon={<AtSign className="h-4 w-4" />} value={entry.value.trim()} label={labelText(entry)} />)}
        </Group>
      )}

      {contact.notes?.trim() && (
        <section aria-label="Notes" className="mb-5">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Notes</h3>
          <p className="whitespace-pre-wrap break-words text-sm">{contact.notes}</p>
        </section>
      )}

      {contact.kept_properties > 0 && <KeptProperties id={contact.id} count={contact.kept_properties} />}
    </article>
  );
}
