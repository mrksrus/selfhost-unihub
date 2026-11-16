import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useBookShares, useShareCandidates } from '@/hooks/use-address-books';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { addressBooksApi, addressBooksQueryKeys, type AddressBook, type SetShareRequest, type SharePermission } from '@/lib/address-books-api';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Who a shared book is shared with, for whoever manages it: people, groups
// and (an administrator's) Everyone, each reading or editing. A change is
// sent as it is made. The server decides the reach: a member shares with
// their own groups and the people in them, and its refusal is shown in its
// own words.

type Principal = SetShareRequest['principal'];
const keyOf = (principal: Principal) => (principal.kind === 'everyone' ? 'everyone' : `${principal.kind}:${principal.id}`);
const LEVELS: Record<SharePermission, string> = { read: 'Can read', edit: 'Can edit' };

function LevelSelect({ value, label, disabled, onChange }: { value: SharePermission; label: string; disabled?: boolean; onChange: (level: SharePermission) => void }) {
  return (
    <Select value={value} onValueChange={next => onChange(next as SharePermission)} disabled={disabled}>
      <SelectTrigger aria-label={label} className="h-9 w-28 shrink-0 touch:h-10"><SelectValue /></SelectTrigger>
      <SelectContent>{(Object.keys(LEVELS) as SharePermission[]).map(level => <SelectItem key={level} value={level}>{LEVELS[level]}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function Who({ name, detail }: { name: string; detail?: string | null }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm">{name}</span>
      {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
    </span>
  );
}

export function BookShareDialog({ book, open, onClose }: { book: Pick<AddressBook, 'id' | 'name'>; open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<SharePermission>('read');
  useEffect(() => { if (!open) { setQuery(''); setLevel('read'); } }, [open]);
  const shares = useBookShares(book.id, open);
  const candidates = useShareCandidates(book.id, query, open);
  const change = useSessionMutation({
    mutationFn: ({ principal, permission }: SetShareRequest & { name: string }) => addressBooksApi.setShare(book.id, { principal, permission }),
    onSuccess: (next, { name, permission }) => {
      client.setQueryData(addressBooksQueryKeys.shares(book.id), next);
      toast({ title: permission ? `${name} ${permission === 'edit' ? 'can edit' : 'can read'} ${book.name}` : `No longer shared with ${name}` });
    },
    onError: (error: Error) => toast({ title: 'Could not change the share', description: error.message, variant: 'destructive' }),
  });

  const shared = new Set((shares.data ?? []).map(share => keyOf(share.principal)));
  const needle = query.trim().toLowerCase();
  const found: { principal: Principal; name: string; detail: string | null }[] = candidates.data ? [
    ...(candidates.data.everyone && 'everyone'.includes(needle) ? [{ principal: { kind: 'everyone' } as const, name: 'Everyone', detail: 'Every active person on this server' }] : []),
    ...candidates.data.groups.map(group => ({ principal: { kind: 'group', id: group.id } as const, name: group.name, detail: 'Group' })),
    ...candidates.data.people.map(person => ({ principal: { kind: 'user', id: person.id } as const, name: person.full_name || person.email, detail: person.full_name ? person.email : null })),
  ].filter(entry => !shared.has(keyOf(entry.principal))) : [];

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Share {book.name}</DialogTitle>
          <DialogDescription>They find it under Contacts, in Shared. A change applies as soon as you make it.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain">
          <section aria-label="Shared with">
            <h3 className="text-sm font-medium">Shared with</h3>
            {shares.isLoading ? <LoadingState compact label="Loading…" />
              : shares.error ? <ErrorState title="Could not load who has this book" error={shares.error} onRetry={() => void shares.refetch()} retrying={shares.isFetching} />
              : (
                <ul className="mt-1 divide-y divide-border">
                  {(shares.data ?? []).map(share => (
                    <li key={keyOf(share.principal)} className="flex items-center gap-2 py-2 touch:gap-3">
                      <Who name={share.name} detail={share.email ?? (share.principal.kind === 'group' ? 'Group' : share.principal.kind === 'everyone' ? 'Every active person on this server' : null)} />
                      {share.permission === 'manage' ? <span className="shrink-0 text-sm text-muted-foreground">Manages it</span> : (
                        <>
                          <LevelSelect value={share.permission} label={`What ${share.name} may do`} disabled={change.isPending}
                            onChange={permission => change.mutate({ principal: share.principal, permission, name: share.name })} />
                          <Button variant="outline" size="sm" disabled={change.isPending} aria-label={`Stop sharing with ${share.name}`}
                            onClick={() => change.mutate({ principal: share.principal, permission: null, name: share.name })}>Remove</Button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
          </section>
          <section aria-label="Add people or groups">
            <Label htmlFor="book-share-search">Add people or groups</Label>
            <div className="mt-2 flex items-center gap-2">
              <Input id="book-share-search" type="search" autoComplete="off" placeholder="Name, email or group" value={query} onChange={event => setQuery(event.target.value)} />
              <LevelSelect value={level} label="What they may do" onChange={setLevel} />
            </div>
            {!can(user, 'contacts.books.manage') && <p className="mt-2 text-xs text-muted-foreground">You can share with the groups you are in and the people in them. An administrator can share with anyone.</p>}
            {candidates.error ? <p role="alert" className="py-3 text-sm text-destructive">{candidates.error.message}</p>
              : candidates.isLoading ? <p role="status" className="py-3 text-sm text-muted-foreground">Searching…</p>
              : found.length === 0 ? <p className="py-3 text-sm text-muted-foreground">{needle ? 'Nobody and no group you can share with matches.' : 'Everyone you can share with has this book already.'}</p>
              : (
                <ul aria-label="People and groups to add" className="mt-1 divide-y divide-border">
                  {found.map(entry => (
                    <li key={keyOf(entry.principal)} className="flex items-center gap-3 py-2">
                      <Who name={entry.name} detail={entry.detail} />
                      <Button variant="outline" size="sm" disabled={change.isPending} aria-label={`Share with ${entry.name}`}
                        onClick={() => change.mutate({ principal: entry.principal, permission: level, name: entry.name })}>Add</Button>
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
