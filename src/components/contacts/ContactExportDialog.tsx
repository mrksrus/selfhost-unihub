import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ExportFormat } from '@/lib/contacts-api';
import type { ContactActions } from '@/hooks/use-contact-actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioRow } from '@/components/ui/radio';

const FORMATS: { id: ExportFormat; label: string; note: string }[] = [
  { id: 'vcard4', label: 'vCard 4.0', note: 'Recommended. Keeps every field, the photo and the details kept from imports.' },
  { id: 'vcard3', label: 'vCard 3.0', note: 'For older apps and phones that do not read 4.0.' },
  { id: 'google-csv', label: 'Google CSV', note: 'The Google Contacts layout. Every value fits.' },
  { id: 'outlook-csv', label: 'Outlook CSV', note: 'Outlook has fixed columns: three emails, fixed phone types, three addresses. Values beyond them go into Notes under "More from UniHub".' },
];

/** Which file to write, for every contact or the selection. */
export function ContactExportDialog({ target, onClose, actions }: {
  /** null: closed; [] : every contact; ids: the selection. */
  target: string[] | null; onClose: () => void; actions: ContactActions;
}) {
  const [format, setFormat] = useState<ExportFormat>('vcard4');
  const selection = target && target.length > 0 ? target : null;
  const what = selection ? `${selection.length} selected contact${selection.length === 1 ? '' : 's'}` : 'all contacts';
  const run = () => actions.exportContacts.mutate({ ids: selection, format }, { onSuccess: onClose });
  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open && !actions.exportContacts.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export {what}</DialogTitle>
          <DialogDescription>Choose the file format for the app that will read it.</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-1">
          <legend className="sr-only">Format</legend>
          {FORMATS.map(entry => (
            <RadioRow key={entry.id} id={`export-${entry.id}`} name="export-format" checked={format === entry.id} onChange={() => setFormat(entry.id)}
              label={<span className="font-medium">{entry.label}</span>} description={entry.note} />
          ))}
        </fieldset>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" onClick={onClose} disabled={actions.exportContacts.isPending}>Cancel</Button>
          <Button type="button" onClick={run} disabled={actions.exportContacts.isPending}>
            {actions.exportContacts.isPending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
