import { useMemo, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { duplicatesQueryOptions, type Contact, type DuplicateConfidence, type DuplicateGroup, type DuplicateMember } from '@/lib/contacts-api';
import { mergesWithoutChoice, reasonText } from '@/lib/contact-fields';
import type { ContactActions } from '@/hooks/use-contact-actions';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Chip, ChipGroup } from '@/components/ui/chips';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { ContactRow } from '@/components/contacts/ContactList';

const CONFIDENCE_TEXT: Record<DuplicateConfidence, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };
type Filter = 'all' | DuplicateConfidence;

/** A member whose full record is not in the page's list yet (it was just created elsewhere). */
function MemberFallback({ member, onOpen }: { member: DuplicateMember; onOpen: () => void }) {
  return (
    <li className="flex items-center gap-3 rounded-md pl-1 pr-1 hover:bg-muted/50">
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground touch:h-10 touch:w-10">{member.display_name.charAt(0).toUpperCase() || '?'}</span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="block truncate text-sm font-medium">{member.display_name || 'No name'}</span>
        <span className="block truncate text-xs text-muted-foreground">{[member.organization, member.phones[0] || member.emails[0]].filter(Boolean).join(' · ')}</span>
      </button>
    </li>
  );
}

/**
 * The groups the server finds, with why, how sure it is and whether a merge
 * needs a choice. Merging is never automatic: a group is reviewed, or the
 * high-confidence groups without conflicts are merged together after a
 * confirmation. Everything can be undone for 30 days.
 */
export function DuplicatesView({ contacts, activeId, selectedIds, actions, onOpen, onToggleSelect, onToggleFavorite, onReview, onMergeAll }: {
  contacts: Contact[];
  activeId: string | null;
  selectedIds: Set<string>;
  actions: ContactActions;
  onOpen: (contact: Contact, event: MouseEvent) => void;
  onToggleSelect: (contact: Contact) => void;
  onToggleFavorite: (contact: Contact) => void;
  onReview: (group: DuplicateGroup) => void;
  onMergeAll: (groups: DuplicateGroup[]) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const query = useQuery(duplicatesQueryOptions('low'));
  const byId = useMemo(() => new Map(contacts.map(contact => [contact.id, contact])), [contacts]);
  const groups = query.data?.groups ?? [];
  const shown = filter === 'all' ? groups : groups.filter(group => group.confidence === filter);
  const mergeable = groups.filter(mergesWithoutChoice);
  const counts = { all: groups.length, high: 0, medium: 0, low: 0 };
  for (const group of groups) counts[group.confidence] += 1;

  if (query.isLoading) return <LoadingState label="Looking for duplicates…" />;
  if (query.error) return <ErrorState title="Could not check for duplicates" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  if (!groups.length) return <EmptyState icon={Copy} title="No duplicates found" description="Contacts that share an email, a number or a name would be listed here." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ChipGroup label="Confidence" className="flex-1">
          {(['all', 'high', 'medium', 'low'] as Filter[]).map(value => (
            <Chip key={value} selected={filter === value} onSelect={() => setFilter(value)} count={counts[value]} countLabel="groups">
              {value === 'all' ? 'All' : CONFIDENCE_TEXT[value].replace(' confidence', '')}
            </Chip>
          ))}
        </ChipGroup>
        {mergeable.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => onMergeAll(mergeable)} disabled={actions.mergeAll.isPending}>
            Merge all high-confidence ({mergeable.length})
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        A merge keeps every number, email and other value of every contact, and can be undone for 30 days under Recently merged.
      </p>
      {shown.length === 0 && <EmptyState compact icon={Copy} title={`No ${filter} confidence groups`} />}
      {shown.map(group => {
        const reasons = [...new Set(group.reasons.map(reasonText))];
        const needsChoice = group.conflicts.length > 0;
        return (
          <section key={group.id} aria-label={`Group of ${group.members.length}, ${CONFIDENCE_TEXT[group.confidence].toLowerCase()}`} className="rounded-lg border border-border p-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-1 pt-2 text-xs">
              <span className={cn('font-medium', group.confidence === 'high' ? 'text-foreground' : 'text-muted-foreground')}>{CONFIDENCE_TEXT[group.confidence]}</span>
              {needsChoice && <span className="font-medium text-warning">Needs your choice</span>}
              {group.large && <span className="font-medium text-warning">Large group, check carefully</span>}
              <span className="text-muted-foreground">{reasons.join(' · ')}</span>
            </div>
            <ul>
              {group.members.map(member => {
                const contact = byId.get(member.id);
                return contact
                  ? <ContactRow key={member.id} contact={contact} active={member.id === activeId} selected={selectedIds.has(member.id)}
                      onOpen={event => onOpen(contact, event)} onToggleSelect={() => onToggleSelect(contact)} onToggleFavorite={() => onToggleFavorite(contact)} />
                  : <MemberFallback key={member.id} member={member} onOpen={() => { /* not in the list yet: review shows it */ onReview(group); }} />;
              })}
            </ul>
            <div className="flex flex-wrap gap-2 px-1 pb-1 pt-2 touch:gap-3">
              <Button variant="outline" size="sm" onClick={() => onReview(group)}>Review and merge</Button>
              <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={actions.dismissDuplicates.isPending}
                onClick={() => actions.dismissDuplicates.mutate(group.members.map(member => member.id))}>Not the same person</Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
