import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Edit, FileAudio, Loader2, Music2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { recordingsApi, recordingsQueryKeys, type Recording } from '@/lib/recordings-api';

const EMPTY_RECORDINGS: Recording[] = [];

function formatDuration(value: number | null) {
  if (!value || value < 0) return 'Unknown length';
  const total = Math.round(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatRecordedAt(value: string | null | undefined) {
  if (!value) return 'No recording date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No recording date';
  return date.toLocaleString();
}

const Music = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);

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
  const hasChords = useMemo(
    () => musicRecordings.filter((recording) => recording.metadata?.chords?.trim()),
    [musicRecordings]
  );

  const saveChords = useMutation({
    mutationFn: async ({ recording, chords }: { recording: Recording; chords: string }) => recordingsApi.update(recording.id, {
      category: 'music',
      metadata: { chords },
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: recordingsQueryKeys.all });
      setDrafts((current) => {
        const next = { ...current };
        delete next[variables.recording.id];
        return next;
      });
      setEditingId(null);
      toast({ title: 'Chords saved' });
    },
    onError: (error: Error) => {
      toast({ title: 'Could not save chords', description: error.message, variant: 'destructive' });
    },
  });

  const updateDraft = (recording: Recording, value: string) => {
    setDrafts((current) => ({ ...current, [recording.id]: value }));
  };

  const getDraft = (recording: Recording) => (
    Object.prototype.hasOwnProperty.call(drafts, recording.id)
      ? drafts[recording.id]
      : recording.metadata?.chords || ''
  );

  const renderRecordingCard = (recording: Recording, mode: 'read' | 'missing') => {
    const isEditing = editingId === recording.id || mode === 'missing';
    const draft = getDraft(recording);

    return (
      <div key={recording.id} className="rounded-lg border border-border p-4">
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="font-semibold text-foreground truncate">{recording.title}</h2>
              <p className="text-xs text-muted-foreground">
                {formatRecordedAt(recording.recorded_at)} • {formatDuration(recording.duration_seconds)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {recording.tags.map((tagName) => (
                <Badge key={tagName} variant="secondary">{tagName}</Badge>
              ))}
            </div>
          </div>

          {recording.description && <p className="text-sm text-muted-foreground">{recording.description}</p>}
          <audio controls className="w-full" src={`/api/recordings/${recording.id}/file`} />

          {isEditing ? (
            <div className="space-y-2">
              <Textarea
                value={draft}
                onChange={(event) => updateDraft(recording, event.target.value)}
                placeholder="C  G  Am  F"
                rows={5}
              />
              <div className="flex flex-wrap justify-end gap-2">
                {mode === 'read' && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditingId(null);
                      setDrafts((current) => {
                        const next = { ...current };
                        delete next[recording.id];
                        return next;
                      });
                    }}
                  >
                    Cancel
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={() => saveChords.mutate({ recording, chords: draft })}
                  disabled={saveChords.isPending}
                >
                  {saveChords.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                  Save chords
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm text-foreground font-sans">
                {recording.metadata.chords}
              </pre>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingId(recording.id);
                    updateDraft(recording, recording.metadata?.chords || '');
                  }}
                >
                  <Edit className="h-4 w-4 mr-2" />
                  Edit chords
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const isLoading = musicQuery.isLoading || missingChordsQuery.isLoading;
  const hasError = musicQuery.error || missingChordsQuery.error;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Music</h1>
          <p className="text-muted-foreground">Review music recordings and document their chords</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/recordings">Open Recordings</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-accent/10">
              <Music2 className="h-5 w-5 text-accent" />
            </div>
            <div>
              <CardTitle className="text-lg">Music Recordings</CardTitle>
              <CardDescription>{musicRecordings.length} music recordings</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : hasError ? (
            <p className="text-sm text-destructive">Could not load music recordings.</p>
          ) : (
            <Tabs defaultValue="has-chords">
              <TabsList className="mb-4">
                <TabsTrigger value="has-chords">Has Chords</TabsTrigger>
                <TabsTrigger value="missing-chords">Missing Chords</TabsTrigger>
              </TabsList>

              <TabsContent value="has-chords" className="space-y-3">
                {hasChords.length === 0 ? (
                  <div className="py-10 text-center text-muted-foreground">
                    <FileAudio className="h-10 w-10 mx-auto mb-3 opacity-50" />
                    <p>No music recordings with chords yet.</p>
                  </div>
                ) : (
                  hasChords.map((recording) => renderRecordingCard(recording, 'read'))
                )}
              </TabsContent>

              <TabsContent value="missing-chords" className="space-y-3">
                {missingChords.length === 0 ? (
                  <div className="py-10 text-center text-muted-foreground">
                    <Music2 className="h-10 w-10 mx-auto mb-3 opacity-50" />
                    <p>No music recordings are missing chords.</p>
                  </div>
                ) : (
                  missingChords.map((recording) => renderRecordingCard(recording, 'missing'))
                )}
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Music;
