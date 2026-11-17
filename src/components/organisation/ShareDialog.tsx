import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { ShareCandidatesResponse } from '../../../api/src/contracts/address-books';
import type { Principal } from '../../../api/src/contracts/organisation';

// Who something is shared with (a shared address book, a calendar), for
// whoever manages it: people, groups and (an administrator's) Everyone, each
// at a level. A change is sent as it is made. The server decides the reach: a
// member shares with their own groups and the people in them, and its refusal
// is shown in its own words.

const principalKey = (principal: Principal) => (principal.kind === 'everyone' ? 'everyone' : `${principal.kind}:${principal.id}`);

interface Listing<T> { data: T | undefined; isLoading: boolean; isFetching: boolean; error: Error | null; refetch: () => unknown }
export interface ShareChange<L extends string> { principal: Principal; permission: L | null; name: string }

interface Props<L extends string> {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description: string;
  /** What is shared, for the messages: "book", "calendar". */
  noun: string;
  /** The levels a share can be given, lowest first, with their words. */
  levels: Record<L, string>;
  /** What a share at any other level reads as (the creator of a book). */
  fixed?: string;
  shares: Listing<{ principal: Principal; name: string; email: string | null; permission: string }[]>;
  /** The search the caller keeps, and the people and groups within reach that match it. */
  query: string;
  onQuery: (query: string) => void;
  candidates: Listing<ShareCandidatesResponse>;
  /** Whether this person may raise that share; without it every level is offered. */
  mayRaise?: (principal: Principal) => boolean;
  /** Said under the search: whom the person can share with, what a level means. */
  notes?: (string | false)[];
  pending: boolean;
  onChange: (change: ShareChange<L>) => void;
  levelClassName?: string;
}

function Who({ name, detail }: { name: string; detail?: string | null }) {
  return (
    <span className="min-w-[8rem] flex-1">
      <span className="block truncate text-sm">{name}</span>
      {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
    </span>
  );
}

export function ShareDialog<L extends string>({ open, onClose, title, description, noun, levels, fixed, shares, query, onQuery, candidates, mayRaise, notes = [], pending, onChange, levelClassName = 'w-28' }: Props<L>) {
  const order = Object.keys(levels) as L[];
  const first = order[0];
  const [level, setLevel] = useState<L>(first);
  useEffect(() => { if (!open) { onQuery(''); setLevel(first); } }, [open, first, onQuery]);

  const levelSelect = (value: L, label: string, offered: L[], change: (next: L) => void, disabled?: boolean) => (
    <Select value={value} onValueChange={next => change(next as L)} disabled={disabled}>
      <SelectTrigger aria-label={label} className={cn('h-9 shrink-0 touch:h-10', levelClassName)}><SelectValue /></SelectTrigger>
      <SelectContent>{offered.map(entry => <SelectItem key={entry} value={entry}>{levels[entry]}</SelectItem>)}</SelectContent>
    </Select>
  );

  const shared = new Set((shares.data ?? []).map(share => principalKey(share.principal)));
  const needle = query.trim().toLowerCase();
  const found: { principal: Principal; name: string; detail: string | null }[] = candidates.data ? [
    ...(candidates.data.everyone && 'everyone'.includes(needle) ? [{ principal: { kind: 'everyone' } as const, name: 'Everyone', detail: 'Every active person on this server' }] : []),
    ...candidates.data.groups.map(group => ({ principal: { kind: 'group', id: group.id } as const, name: group.name, detail: 'Group' })),
    ...candidates.data.people.map(person => ({ principal: { kind: 'user', id: person.id } as const, name: person.full_name || person.email, detail: person.full_name ? person.email : null })),
  ].filter(entry => !shared.has(principalKey(entry.principal))) : [];

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain">
          <section aria-label="Shared with">
            <h3 className="text-sm font-medium">Shared with</h3>
            {shares.isLoading ? <LoadingState compact label="Loading…" />
              : shares.error ? <ErrorState title={`Could not load who has this ${noun}`} error={shares.error} onRetry={() => void shares.refetch()} retrying={shares.isFetching} />
              : shares.data?.length === 0 ? <p className="py-2 text-sm text-muted-foreground">Nobody yet.</p>
              : (
                <ul className="mt-1 divide-y divide-border">
                  {(shares.data ?? []).map(share => {
                    const at = order.indexOf(share.permission as L);
                    // Lowering is always allowed; a raise only within the person's reach.
                    const offered = !mayRaise || mayRaise(share.principal) ? order : order.slice(0, at + 1);
                    return (
                      // On a narrow screen a wide level control moves under the name instead of squeezing it.
                      <li key={principalKey(share.principal)} className="flex flex-wrap items-center justify-end gap-2 py-2 touch:gap-3">
                        <Who name={share.name} detail={share.email ?? (share.principal.kind === 'group' ? 'Group' : share.principal.kind === 'everyone' ? 'Every active person on this server' : null)} />
                        {at === -1 ? <span className="shrink-0 text-sm text-muted-foreground">{fixed}</span> : (
                          <span className="flex items-center gap-2 touch:gap-3">
                            {levelSelect(share.permission as L, `What ${share.name} may do`, offered, permission => onChange({ principal: share.principal, permission, name: share.name }), pending)}
                            <Button variant="outline" size="sm" disabled={pending} aria-label={`Stop sharing with ${share.name}`}
                              onClick={() => onChange({ principal: share.principal, permission: null, name: share.name })}>Remove</Button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
          </section>
          <section>
            <Label htmlFor={`${noun}-share-search`}>Add people or groups</Label>
            <div className="mt-2 flex items-center gap-2">
              <Input id={`${noun}-share-search`} type="search" autoComplete="off" placeholder="Name, email or group" value={query} onChange={event => onQuery(event.target.value)} />
              {levelSelect(level, 'What they may do', order, setLevel)}
            </div>
            {notes.filter(Boolean).map(note => <p key={note as string} className="mt-2 text-xs text-muted-foreground">{note}</p>)}
            {candidates.error ? <p role="alert" className="py-3 text-sm text-destructive">{candidates.error.message}</p>
              : candidates.isLoading ? <p role="status" className="py-3 text-sm text-muted-foreground">Searching…</p>
              : found.length === 0 ? <p className="py-3 text-sm text-muted-foreground">{needle ? 'Nobody and no group you can share with matches.' : `Everyone you can share with has this ${noun} already.`}</p>
              : (
                <ul aria-label="People and groups to add" className="mt-1 divide-y divide-border">
                  {found.map(entry => (
                    <li key={principalKey(entry.principal)} className="flex items-center gap-3 py-2">
                      <Who name={entry.name} detail={entry.detail} />
                      <Button variant="outline" size="sm" disabled={pending} aria-label={`Share with ${entry.name}`}
                        onClick={() => onChange({ principal: entry.principal, permission: level, name: entry.name })}>Add</Button>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
        <DialogFooter className="shrink-0">
          <Button type="button" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
