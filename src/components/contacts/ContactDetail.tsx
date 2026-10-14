import type { MouseEvent, ReactNode } from 'react';
import { ArrowLeft, Copy, Mail, MoreHorizontal, Phone, Star } from 'lucide-react';
import { contactEmails, contactInitials, contactName, contactPhones, type Contact } from '@/lib/contacts-api';
import { copyText } from '@/lib/platform';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface Props {
  contact: Contact;
  /** Compose inside UniHub instead of following the mailto: link. */
  onEmail?: (address: string) => void;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
}

/** A row that does one thing (write, call) and offers to copy the value. */
function LinkRow({ href, icon, label, value, onClick }: { href: string; icon: ReactNode; label: string; value: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  const { toast } = useToast();
  const copy = async () => {
    const copied = await copyText(value);
    toast(copied ? { title: 'Copied' } : { title: 'Could not copy', variant: 'destructive' });
  };
  return (
    <li className="group flex items-center gap-1 rounded-md hover:bg-muted/50">
      <a href={href} onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span aria-hidden="true" className="text-muted-foreground">{icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm text-accent">{value}</span>
          <span className="block text-xs text-muted-foreground">{label}</span>
        </span>
      </a>
      <Button variant="ghost" size="icon-sm" className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        aria-label={`Copy ${value}`} onClick={() => void copy()}>
        <Copy aria-hidden="true" />
      </Button>
    </li>
  );
}

export function ContactDetail({ contact, onEmail, onBack, onEdit, onDelete, onToggleFavorite }: Props) {
  const name = contactName(contact);
  const emails = contactEmails(contact);
  const phones = contactPhones(contact);
  const role = [contact.job_title, contact.company].filter(Boolean).join(', ');
  const numbered = (label: string, list: string[], index: number) => list.length > 1 ? `${label} ${index + 1}` : label;

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
        <span aria-hidden="true" className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-medium text-muted-foreground">
          {contactInitials(contact)}
        </span>
        <div className="min-w-0">
          <h2 className="break-words text-xl font-semibold tracking-tight">{name}</h2>
          {role && <p className="text-sm text-muted-foreground">{role}</p>}
        </div>
      </div>

      {emails.length + phones.length > 0 ? (
        <ul className="-mx-2 mb-6">
          {emails.map((address, index) => (
            <LinkRow key={`e${index}`} href={`mailto:${address}`} icon={<Mail className="h-4 w-4" />} label={numbered('Email', emails, index)} value={address}
              onClick={onEmail ? (event) => { event.preventDefault(); onEmail(address); } : undefined} />
          ))}
          {phones.map((number, index) => (
            <LinkRow key={`p${index}`} href={`tel:${number.replace(/\s/g, '')}`} icon={<Phone className="h-4 w-4" />} label={numbered('Phone', phones, index)} value={number} />
          ))}
        </ul>
      ) : (
        <p className="mb-6 text-sm text-muted-foreground">No email or phone number yet.</p>
      )}


      {contact.notes?.trim() && (
        <section aria-label="Notes">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Notes</h3>
          <p className="whitespace-pre-wrap break-words text-sm">{contact.notes}</p>
        </section>
      )}
    </article>
  );
}
