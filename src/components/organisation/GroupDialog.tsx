import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { GroupSummary } from '@/lib/groups-api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const GROUP_WORDS = { noun: 'group', created: 'Add people and rules to it next. A group can only make a rule stricter than it is for everyone.', renamed: 'Its members and rules stay as they are.' };

/** A new group, or the name and description of an existing one (what its manager may change). A shared address book is named the same way, with its own `words`. */
export function GroupDialog({ open, group, pending, onClose, onSubmit, words = GROUP_WORDS }: {
  open: boolean; group?: Pick<GroupSummary, 'name' | 'description'> | null; pending: boolean; onClose: () => void;
  onSubmit: (input: { name: string; description: string | null }) => void;
  words?: { noun: string; created: string; renamed: string };
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => { if (open) { setName(group?.name ?? ''); setDescription(group?.description ?? ''); } }, [open, group?.name, group?.description]);
  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !pending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{group ? `Rename ${words.noun}` : `New ${words.noun}`}</DialogTitle>
          <DialogDescription>{group ? words.renamed : words.created}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (trimmed && !pending) onSubmit({ name: trimmed, description: description.trim() || null }); }}>
          <div className="space-y-2">
            <Label htmlFor="group-name">Name</Label>
            <Input id="group-name" value={name} maxLength={100} autoComplete="off" onChange={event => setName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="group-description">Description</Label>
            <Textarea id="group-description" value={description} maxLength={500} rows={2} onChange={event => setDescription(event.target.value)} />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={!trimmed || pending}>{pending && <Loader2 aria-hidden="true" className="animate-spin" />}{group ? 'Save' : `Create ${words.noun}`}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
