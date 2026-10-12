import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, FileAudio, ListMusic, Loader2, Music2 } from 'lucide-react';
import { recordingsApi, recordingsQueryKeys, type Recording } from '@/lib/recordings-api';
import { formatDuration, formatRecordedAt } from '@/lib/recording-format';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell, PanelGroup, PanelHeader, PanelItem } from '@/components/layout/PageShell';
import { RecordingPlayer } from '@/components/recordings/RecordingPlayer';

const EMPTY_RECORDINGS: Recording[] = [];
type View = 'chords' | 'missing';
const VIEWS: Record<View, { label: string; icon: typeof Music2 }> = {
  chords: { label: 'With chords', icon: ListMusic },
  missing: { label: 'Missing chords', icon: Music2 },
};

function SongRow({ recording, open, onToggle, startEditing, saving, onSave }: {
  recording: Recording; open: boolean; onToggle: () => void; startEditing: boolean; saving: boolean; onSave: (chords: string, done: () => void) => void;
}) {
  const chords = recording.metadata?.chords || '';
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(chords);
  const edit = () => { setDraft(chords); setEditing(true); };
  return (
    <li className="border-b border-border">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center gap-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <FileAudio aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{recording.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {[formatRecordedAt(recording.recorded_at), formatDuration(recording.duration_seconds), ...recording.tags].join(' · ')}
          </span>
        </span>
        <ChevronDown aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-3 pb-4 pl-7">
          <RecordingPlayer id={recording.id} />
          {recording.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{recording.description}</p>}
          {editing ? (
            <form className="space-y-2" onSubmit={event => { event.preventDefault(); onSave(draft, () => setEditing(false)); }}>
              <Textarea aria-label={`Chords for ${recording.title}`} value={draft} onChange={event => setDraft(event.target.value)} placeholder="C  G  Am  F" rows={5} className="font-mono" autoFocus />
              <div className="flex justify-end gap-2">
                {chords && <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
                <Button type="submit" disabled={saving}>{saving && <Loader2 aria-hidden="true" className="animate-spin" />}Save chords</Button>
              </div>
            </form>
          ) : (
            <>
              <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-sm">{chords}</pre>
              <Button variant="outline" size="sm" onClick={edit}>Edit chords</Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

const Music = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'missing' ? 'missing' : 'chords';
  const [openId, setOpenId] = useState<string | null>(null);

  const musicQuery = useQuery({
    queryKey: recordingsQueryKeys.list({ category: 'music' }),
    queryFn: () => recordingsApi.list({ category: 'music' }),
  });
  const missingChordsQuery = useQuery({
    queryKey: recordingsQueryKeys.list({ category: 'music', musicMissingChords: true }),
    queryFn: () => recordingsApi.list({ category: 'music', musicMissingChords: true }),
  });
  const musicRecordings = musicQuery.data ?? EMPTY_RECORDINGS;
  const missingChords = missingChordsQuery.data ?? EMPTY_RECORDINGS;
  const withChords = useMemo(() => musicRecordings.filter(recording => recording.metadata?.chords?.trim()), [musicRecordings]);

  const saveChords = useMutation({
    mutationFn: ({ recording, chords }: { recording: Recording; chords: string }) => recordingsApi.update(recording.id, { category: 'music', metadata: { chords } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recordingsQueryKeys.all });
      toast({ title: 'Chords saved' });
    },
    onError: (error: Error) => toast({ title: 'Could not save chords', description: error.message, variant: 'destructive' }),
  });

  const selectView = (next: View) => {
    setOpenId(null);
    setParams(next === 'chords' ? {} : { view: next }, { replace: true });
  };
  const list = view === 'chords' ? withChords : missingChords;
  const error = musicQuery.error || missingChordsQuery.error;

  const panel = (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PanelHeader title="Music" />
      <PanelGroup>
        {(Object.keys(VIEWS) as View[]).map(id => (
          <PanelItem key={id} icon={VIEWS[id].icon} active={view === id} onSelect={() => selectView(id)}
            count={(id === 'chords' ? withChords : missingChords).length} countLabel="songs" countTone={id === 'missing' ? 'warning' : 'default'}>
            {VIEWS[id].label}
          </PanelItem>
        ))}
      </PanelGroup>

    </div>
  );

  return (
    <PageShell panel={panel} panelLabel="Music lists">
      <PageHeader title="Music" scope={VIEWS[view].label} />
      <PageBody width="reading">
        {musicQuery.isLoading || missingChordsQuery.isLoading ? <LoadingState label="Loading music…" />
          : error ? <ErrorState title="Could not load music" error={error} onRetry={() => { void musicQuery.refetch(); void missingChordsQuery.refetch(); }} retrying={musicQuery.isFetching || missingChordsQuery.isFetching} />
          : list.length === 0 ? (
            <EmptyState icon={Music2}
              title={musicRecordings.length === 0 ? 'No music yet' : view === 'chords' ? 'No chords written down yet' : 'Every song has chords'}
              description={musicRecordings.length === 0 ? 'Set a recording\'s category to Music to see it here.' : undefined}
              action={musicRecordings.length === 0 ? <Button asChild variant="outline"><Link to="/recordings">Open Recordings</Link></Button> : undefined} />
          ) : (
            <ul className="border-t border-border">
              {list.map(recording => (
                <SongRow key={`${view}:${recording.id}`} recording={recording} open={openId === recording.id} startEditing={view === 'missing'}
                  onToggle={() => setOpenId(openId === recording.id ? null : recording.id)} saving={saveChords.isPending}
                  onSave={(chords, done) => saveChords.mutate({ recording, chords }, { onSuccess: done })} />
              ))}
            </ul>
          )}
      </PageBody>
    </PageShell>
  );
};

export default Music;
