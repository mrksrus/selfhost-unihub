import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { ChatCandidatesResponse, ChatEngine } from '@/lib/chat/types';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSessionScope } from '@/lib/session-scope';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioRow } from '@/components/ui/radio';
import { chatHref } from '@/components/chat/chat-state';

// A new group chat, and more people for one. The server decides whom the
// person reaches, which groups they may follow and how many people a chat
// takes; its refusal is shown in its own words and the dialog stays.

// An administrator may make a chat follow a group they are not in, and is then not in the chat either.
const NOT_IN_IT = 'If you are not in the group yourself, you will not see the chat.';

type Person = ChatCandidatesResponse['people'][number];
const nameOf = (person: Person) => person.full_name || person.email;

const useCandidates = (engine: ChatEngine, query: string) => {
  const search = useDebouncedValue(query.trim());
  return useQuery({ queryKey: ['chat', 'candidates', search], queryFn: () => engine.candidates(search), placeholderData: keepPreviousData });
};

/** People within reach, searched by name or address and ticked; the ticked ones stay while the search changes. */
function PeoplePicker({ engine, picked, onPicked, already = [] }: { engine: ChatEngine; picked: Person[]; onPicked: (people: Person[]) => void; already?: string[] }) {
  const [query, setQuery] = useState('');
  const candidates = useCandidates(engine, query);
  const found = (candidates.data?.people ?? []).filter(person => !already.includes(person.id));
  const listed = [...picked.filter(person => !found.some(entry => entry.id === person.id)), ...found];
  return (
    <>
      <div className="shrink-0 space-y-2">
        <Label htmlFor="chat-people-search">Name or email</Label>
        <Input id="chat-people-search" type="search" autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="min-h-24 flex-1 overflow-y-auto overscroll-contain">
        {candidates.error ? <p role="alert" className="py-3 text-sm text-destructive">{candidates.error.message}</p>
          : candidates.isLoading ? <p role="status" className="py-3 text-sm text-muted-foreground">Searching…</p>
          : listed.length === 0 ? <p className="py-3 text-sm text-muted-foreground">{query.trim() ? 'Nobody you can add matches.' : 'There is nobody you can add.'}</p>
          : (
            <ul aria-label="People to add" className="divide-y divide-border">
              {listed.map(person => (
                <li key={person.id} className="flex items-center gap-3 py-2 touch:py-3">
                  <Checkbox id={`chat-person-${person.id}`} checked={picked.some(entry => entry.id === person.id)}
                    onCheckedChange={checked => onPicked([...picked.filter(entry => entry.id !== person.id), ...(checked === true ? [person] : [])])} />
                  <label htmlFor={`chat-person-${person.id}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block truncate text-sm">{nameOf(person)}</span>
                    {person.full_name && <span className="block truncate text-xs text-muted-foreground">{person.email}</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
      </div>
    </>
  );
}

/** The frame both dialogs share: what is asked, the server's refusal, Cancel and the action. Mounted while open, so every opening starts empty. */
function ChatDialog({ title, description, action, ready, run, onClose, children }: {
  title: string; description: string; action: string; ready: boolean; run: () => Promise<unknown>; onClose: () => void; children: ReactNode;
}) {
  const scope = useSessionScope();
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The button that opened it gets the focus back.
  const opener = useRef(document.activeElement as HTMLElement | null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setRefusal(null);
    try { await run(); }
    catch (error) { if (!scope.ended) setRefusal(error instanceof Error ? error.message : 'The server did not answer.'); }
    finally { setPending(false); }
  };
  return (
    <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] flex-col" onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          {refusal && <p role="alert" className="shrink-0 text-sm text-destructive">{refusal}</p>}
          <DialogFooter className="shrink-0 gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={!ready || pending}>{pending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}{action}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A new group chat: its name, and either chosen people or one organisation
 * group it follows. With `follow` (from that group's page) it follows that
 * group and only the name is asked.
 */
export function NewGroupDialog({ engine, follow, onClose }: { engine: ChatEngine; follow?: { id: string; name: string }; onClose: () => void }) {
  const navigate = useNavigate();
  const scope = useSessionScope();
  const [name, setName] = useState(follow?.name ?? '');
  const [picked, setPicked] = useState<Person[]>([]);
  // null: chosen people; else the group the chat follows.
  const [followed, setFollowed] = useState<string | null>(follow?.id ?? null);
  const [choosing, setChoosing] = useState(!follow);
  const reach = useCandidates(engine, '').data;
  const groups = follow ? [] : [...(reach?.everyone ? [{ id: 'everyone', name: 'Everyone on this server' }] : []), ...(reach?.groups ?? [])];
  const create = async () => {
    const id = await engine.createGroup(name.trim(), choosing ? { user_ids: picked.map(person => person.id) }
      : { follow: followed === 'everyone' ? { kind: 'everyone' } : { kind: 'group', id: followed! } });
    if (scope.ended) return;
    onClose();
    navigate(chatHref(id));
  };
  return (
    <ChatDialog title="New group chat" action="Create chat" ready={!!name.trim() && (choosing ? picked.length > 0 : !!followed)} run={create} onClose={onClose}
      description={follow ? `The chat has exactly the members of ${follow.name}: whoever joins the group joins the chat, whoever leaves the group leaves it. ${NOT_IN_IT}`
        : 'Everyone in it reads what is written from the moment they join. Only its people can read it; the server sees its name and who is in it.'}>
      <div className="shrink-0 space-y-2">
        <Label htmlFor="chat-group-name">Name</Label>
        <Input id="chat-group-name" autoComplete="off" maxLength={80} value={name} onChange={event => setName(event.target.value)} />
      </div>
      {groups.length > 0 && (
        <div role="radiogroup" aria-label="Who is in it" className="shrink-0">
          <RadioRow id="chat-group-people" name="chat-group-who" label="People I choose" checked={choosing} onChange={() => setChoosing(true)} />
          <RadioRow id="chat-group-follow" name="chat-group-who" label="The members of a group" description={`The chat changes with the group; nobody is added or removed by hand. ${NOT_IN_IT}`}
            checked={!choosing} onChange={() => setChoosing(false)} />
        </div>
      )}
      {follow ? null : choosing ? <PeoplePicker engine={engine} picked={picked} onPicked={setPicked} /> : (
        <div role="radiogroup" aria-label="Group to follow" className="min-h-24 flex-1 overflow-y-auto overscroll-contain">
          {groups.map(group => <RadioRow key={group.id} id={`chat-follow-${group.id}`} name="chat-follow" label={group.name} checked={followed === group.id} onChange={() => setFollowed(group.id)} />)}
        </div>
      )}
    </ChatDialog>
  );
}

/** More people for a group chat of chosen people; they read from the moment they join. */
export function AddPeopleDialog({ engine, conversationId, chatName, already, retentionDays, onClose }: {
  engine: ChatEngine; conversationId: string; chatName: string; already: string[]; /** After how many days the chat deletes its messages now; null while it keeps them. */ retentionDays: number | null; onClose: () => void;
}) {
  const [picked, setPicked] = useState<Person[]>([]);
  // A chat follows the shortest rule among its people: someone under a shorter one shortens it for everyone.
  const shorter = picked.filter(person => person.retention_days !== null && (retentionDays === null || person.retention_days < retentionDays));
  const days = Math.min(...shorter.map(person => person.retention_days!));
  return (
    <ChatDialog title={`Add people to ${chatName}`} description="They read what is written from the moment they join, not what was written before."
      action={picked.length > 1 ? `Add ${picked.length} people` : 'Add'} ready={picked.length > 0} onClose={onClose}
      run={async () => { await engine.addMembers(conversationId, picked.map(person => person.id)); onClose(); }}>
      <PeoplePicker engine={engine} picked={picked} onPicked={setPicked} already={already} />
      {shorter.length > 0 && (
        <p role="status" className="shrink-0 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          For {shorter.filter(person => person.retention_days === days).map(nameOf).join(' and ')}, chat messages are deleted after {days} days. Once they are in this chat, it will delete messages older than {days} days for everyone, starting 24 hours after they are added.
        </p>
      )}
    </ChatDialog>
  );
}
