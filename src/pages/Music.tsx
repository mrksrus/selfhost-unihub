import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ListMusic, Loader2, Music2, Pencil } from 'lucide-react';
import { recordingsApi, recordingsQueryKeys, type Recording } from '@/lib/recordings-api';
import { formatDuration, formatRecordedAt } from '@/lib/recording-format';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { Chip, ChipGroup } from '@/components/ui/chips';
import { PlayButton, RecordingPlayer } from '@/components/recordings/RecordingPlayer';

const EMPTY_RECORDINGS: Recording[] = [];
type View = 'chords' | 'missing';
const VIEWS: Record<View, { label: string; icon: typeof Music2 }> = {
  chords: { label: 'With chords', icon: ListMusic },
  missing: { label: 'Missing chords', icon: Music2 },
};

/**
 * A song with its chords in view. A song without chords shows the editor
 * right away, which is what the Missing chords view lists.
 */
function SongRow({ recording, playing, onPlay, saving, onSave }: {
  recording: Recording; playing: boolean; onPlay: () => void; saving: boolean; onSave: (chords: string, done: () => void) => void;
}) {
  const chords = recording.metadata?.chords || '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chords);
  const edit = () => { setDraft(chords); setEditing(true); };
  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-3 border-b border-border py-3">
      <PlayButton title={recording.title} playing={playing} onToggle={onPlay} />
      <div className="min-w-0">
        <p className="break-words font-medium">{recording.title}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>{formatRecordedAt(recording.recorded_at)}</span>
          <span>{formatDuration(recording.duration_seconds)}</span>
          {recording.tags.map(tag => <span key={tag}>{tag}</span>)}
        </p>
      </div>
      <div className="col-start-2 mt-2 space-y-2.5">
        {playing && <RecordingPlayer id={recording.id} autoPlay />}
        {recording.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{recording.description}</p>}
        {editing || !chords.trim() ? (
          <form className="space-y-2" onSubmit={event => { event.preventDefault(); onSave(draft, () => setEditing(false)); }}>
            <Textarea aria-label={`Chords for ${recording.title}`} value={draft} onChange={event => setDraft(event.target.value)} placeholder="C  G  Am  F" rows={5} className="font-mono" autoFocus={editing} />
            <div className="flex justify-end gap-2">
              {chords.trim() && <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
              <Button type="submit" disabled={saving}>{saving && <Loader2 aria-hidden="true" className="animate-spin" />}Save chords</Button>
            </div>
          </form>
        ) : (
          <div className="relative">
            <pre className="whitespace-pre-wrap rounded-md bg-muted py-3 pl-3 pr-11 font-mono text-sm">{chords}</pre>
            <Button variant="ghost" size="icon-sm" className="absolute right-1 top-1 text-muted-foreground" aria-label={`Edit chords for ${recording.title}`} onClick={edit}>
              <Pencil aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

const Music = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'missing' ? 'missing' : 'chords';
  const [playingId, setPlayingId] = useState<string | null>(null);

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
    setPlayingId(null);
    setParams(next === 'chords' ? {} : { view: next }, { replace: true });
  };
  const list = view === 'chords' ? withChords : missingChords;
  const error = musicQuery.error || missingChordsQuery.error;

  return (
    <PageShell>
      <PageHeader title="Music">
        <div className="px-4 pb-3 md:px-6">
          <ChipGroup label="View">
            {(Object.keys(VIEWS) as View[]).map(id => (
              <Chip key={id} icon={VIEWS[id].icon} selected={view === id} onSelect={() => selectView(id)}
                count={(id === 'chords' ? withChords : missingChords).length} countLabel="songs" countTone={id === 'missing' ? 'warning' : 'default'}>
                {VIEWS[id].label}
              </Chip>
            ))}
          </ChipGroup>
        </div>
      </PageHeader>
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
                <SongRow key={recording.id} recording={recording} playing={playingId === recording.id}
                  onPlay={() => setPlayingId(playingId === recording.id ? null : recording.id)} saving={saveChords.isPending}
                  onSave={(chords, done) => saveChords.mutate({ recording, chords }, { onSuccess: done })} />
              ))}
            </ul>
          )}
      </PageBody>
    </PageShell>
  );
};

export default Music;
