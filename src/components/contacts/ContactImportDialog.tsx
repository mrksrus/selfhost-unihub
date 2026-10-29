import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Loader2 } from 'lucide-react';
import { contactsApi, contactsQueryKeys, invalidateContactQueries, type ImportDecisionKind, type ImportGroup, type ImportStatus, type ImportSummary } from '@/lib/contacts-api';
import { reasonText, SINGLE_FIELD_TEXT } from '@/lib/contact-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/page-states';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const FORMAT_TEXT: Record<ImportSummary['format'], string> = { vcard4: 'vCard 4.0', vcard3: 'vCard 3.0', vcard21: 'vCard 2.1', 'google-csv': 'Google CSV', 'outlook-csv': 'Outlook CSV' };
const DECISION_TEXT: Record<ImportDecisionKind, string> = { add: 'Add as new', merge: 'Merge into existing', skip: 'Skip' };
const MATCH_TEXT: Record<ImportGroup['match'], string> = { new: 'New', uid: 'Same contact (identity)', identical: 'Already present', duplicate: 'Likely duplicate' };
const ACCEPT = '.vcf,.vcard,.csv,text/vcard,text/x-vcard,text/csv';

type Step = { kind: 'pick' } | { kind: 'reading' } | { kind: 'summary'; summary: ImportSummary } | { kind: 'committing'; id: string } | { kind: 'done'; status: ImportStatus };

/**
 * Import in two steps: the file is read and matched first, then the person
 * decides per group before anything is written (D6). The commit reports its
 * progress and the result.
 */
export function ContactImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported?: () => void }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [decisions, setDecisions] = useState<Record<string, ImportDecisionKind>>({});
  const [showConflicts, setShowConflicts] = useState(false);
  const [fileName, setFileName] = useState('');

  useEffect(() => { if (open) { setStep({ kind: 'pick' }); setDecisions({}); setShowConflicts(false); setFileName(''); } }, [open]);

  const stage = useMutation({
    mutationFn: (file: File) => contactsApi.stageImport(file),
    onMutate: () => setStep({ kind: 'reading' }),
    onSuccess: summary => {
      setDecisions(Object.fromEntries(summary.groups.map(group => [group.id, group.default_decision])));
      setStep({ kind: 'summary', summary });
    },
    onError: () => setStep({ kind: 'pick' }),
  });
  const commit = useMutation({
    mutationFn: ({ id, groups }: { id: string; groups: ImportGroup[] }) => contactsApi.commitImport(id, groups.map(group => ({ group_id: group.id, decision: decisions[group.id] ?? group.default_decision }))),
    onSuccess: status => setStep(status.status === 'committed' || status.status === 'failed' ? { kind: 'done', status } : { kind: 'committing', id: status.id }),
  });
  const committingId = step.kind === 'committing' ? step.id : null;
  const progress = useQuery({
    queryKey: contactsQueryKeys.importStatus(committingId ?? ''),
    queryFn: ({ signal }) => contactsApi.importStatus(committingId!, signal),
    enabled: !!committingId,
    refetchInterval: query => (query.state.data && ['committed', 'failed', 'expired'].includes(query.state.data.status) ? false : 1000),
  });
  useEffect(() => {
    const status = progress.data;
    if (committingId && status && ['committed', 'failed', 'expired'].includes(status.status)) setStep({ kind: 'done', status });
  }, [committingId, progress.data]);
  useEffect(() => {
    if (step.kind === 'done' && step.status.status === 'committed') { void invalidateContactQueries(client); onImported?.(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind]);

  const busy = stage.isPending || commit.isPending || step.kind === 'committing';
  const pick = (file: File | undefined) => { if (file) { setFileName(file.name); stage.mutate(file); } };

  const setAll = (decision: ImportDecisionKind, groups: ImportGroup[]) =>
    setDecisions(prev => ({ ...prev, ...Object.fromEntries(groups.map(group => [group.id, decision])) }));

  const body = () => {
    if (step.kind === 'pick' || step.kind === 'reading') {
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">A vCard file (4.0, 3.0 or 2.1) or a CSV export from Google Contacts or Outlook. Nothing is written before you confirm.</p>
          <input ref={input} type="file" accept={ACCEPT} className="hidden" aria-label="Choose a file" onChange={event => { pick(event.target.files?.[0]); event.target.value = ''; }} />
          <Button type="button" variant="outline" onClick={() => input.current?.click()} disabled={step.kind === 'reading'}>
            {step.kind === 'reading' ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : <FileUp aria-hidden="true" />}
            {step.kind === 'reading' ? `Reading ${fileName}…` : 'Choose file'}
          </Button>
          {stage.error && <ErrorState title="The file could not be read" error={stage.error} />}
        </div>
      );
    }
    if (step.kind === 'summary') {
      const { summary } = step;
      const decided = summary.groups.filter(group => group.match !== 'new');
      const conflicting = decided.filter(group => group.conflicts.length);
      return (
        <div className="space-y-5 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Format</dt><dd>{FORMAT_TEXT[summary.format] ?? summary.format}</dd>
            <dt className="text-muted-foreground">Contacts in the file</dt><dd>{summary.counts.cards}</dd>
            <dt className="text-muted-foreground">New</dt><dd>{summary.counts.new}</dd>
            <dt className="text-muted-foreground">Already present</dt><dd>{summary.counts.present}</dd>
            <dt className="text-muted-foreground">Likely duplicates</dt><dd>{summary.counts.duplicates}</dd>
          </dl>
          {summary.sample_names.length > 0 && (
            <p><span className="text-muted-foreground">First names in the file: </span>{summary.sample_names.join(', ')}
              <span className="block text-xs text-muted-foreground">If they look garbled, the file's character set was not recognised: export it again as UTF-8 before importing.</span></p>
          )}
          {summary.warnings.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-warning">{summary.warnings.length} warning{summary.warnings.length === 1 ? '' : 's'}</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {summary.warnings.slice(0, 50).map((warning, index) => <li key={index}>{warning.card !== null ? `Contact ${warning.card}: ` : ''}{warning.message}</li>)}
                {summary.warnings.length > 50 && <li>and {summary.warnings.length - 50} more</li>}
              </ul>
            </details>
          )}
          {decided.length > 0 && (
            <section aria-label="Decisions" className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="mr-auto font-medium">What to do with matches</h3>
                <span className="text-xs text-muted-foreground">For all:</span>
                {(['merge', 'add', 'skip'] as ImportDecisionKind[]).map(decision => (
                  <Button key={decision} type="button" variant="ghost" size="sm" onClick={() => setAll(decision, decided)}>{DECISION_TEXT[decision].split(' ')[0]}</Button>
                ))}
                {conflicting.length > 0 && <Button type="button" variant="outline" size="sm" onClick={() => setShowConflicts(value => !value)}>{showConflicts ? 'Hide conflicts' : `Review conflicts (${conflicting.length})`}</Button>}
              </div>
              <ul className="divide-y divide-border">
                {decided.map(group => (
                  <li key={group.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block">{MATCH_TEXT[group.match]}{group.confidence ? ` (${group.confidence})` : ''}: contact{group.cards.length > 1 ? 's' : ''} {group.cards.join(', ')}</span>
                      <span className="block text-xs text-muted-foreground">{[...new Set(group.reasons.map(reasonText))].join(' · ')}</span>
                      {showConflicts && group.conflicts.length > 0 && (
                        <span className="block text-xs text-warning">Differs in {group.conflicts.map(field => SINGLE_FIELD_TEXT[field].toLowerCase()).join(', ')}: UniHub's value is kept when merging.</span>
                      )}
                    </span>
                    <Select value={decisions[group.id] ?? group.default_decision} onValueChange={value => setDecisions(prev => ({ ...prev, [group.id]: value as ImportDecisionKind }))}>
                      <SelectTrigger aria-label={`Decision for contacts ${group.cards.join(', ')}`} className="h-9 w-44"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(['add', 'merge', 'skip'] as ImportDecisionKind[]).map(decision => <SelectItem key={decision} value={decision}>{DECISION_TEXT[decision]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {commit.error && <ErrorState title="The import could not start" error={commit.error} />}
        </div>
      );
    }
    if (step.kind === 'committing') {
      const value = Math.round((progress.data?.progress ?? 0) * 100);
      return (
        <div className="space-y-3">
          <p className="text-sm">Writing contacts… {value}%</p>
          <Progress value={value} aria-label="Import progress" />
          {progress.error && <ErrorState title="Lost track of the import" error={progress.error} onRetry={() => void progress.refetch()} />}
        </div>
      );
    }
    const { status } = step;
    const result = status.result;
    return (
      <div className="space-y-3 text-sm">
        {status.status === 'committed' ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Added</dt><dd>{result?.added ?? 0}</dd>
            <dt className="text-muted-foreground">Merged</dt><dd>{result?.merged ?? 0}</dd>
            <dt className="text-muted-foreground">Skipped</dt><dd>{result?.skipped ?? 0}</dd>
            {result && result.kept_conflicts.length > 0 && <><dt className="text-muted-foreground">Kept UniHub's value</dt><dd>{result.kept_conflicts.length} field{result.kept_conflicts.length === 1 ? '' : 's'} that differed</dd></>}
          </dl>
        ) : <ErrorState title={status.status === 'expired' ? 'The staged file expired' : 'The import failed'} error={`Nothing further was written. ${status.status === 'expired' ? 'Choose the file again.' : 'Try again; already written contacts are not added twice.'}`} />}
        {result && result.warnings.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-warning">{result.warnings.length} warning{result.warnings.length === 1 ? '' : 's'}</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">{result.warnings.slice(0, 50).map((warning, index) => <li key={index}>{warning.message}</li>)}</ul>
          </details>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pb-3 pt-6">
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>{step.kind === 'summary' ? `What ${fileName} would change.` : step.kind === 'done' ? 'Finished.' : 'From a vCard or CSV file.'}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">{body()}</div>
        <DialogFooter className="gap-2 border-t border-border px-6 py-4 sm:gap-0">
          {step.kind === 'summary' ? (
            <>
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button type="button" onClick={() => commit.mutate({ id: step.summary.id, groups: step.summary.groups })} disabled={busy || step.summary.counts.cards === 0}>
                {commit.isPending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Import {step.summary.counts.cards} contact{step.summary.counts.cards === 1 ? '' : 's'}
              </Button>
            </>
          ) : step.kind === 'done' ? <Button type="button" onClick={onClose}>Done</Button>
            : <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
