import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { FileAudio, Loader2, Mic, Pause, Play, Search, Square, Tag, Upload, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import { saveFile } from '@/lib/platform';
import { runRecordingUpload, type RecordingUploadJob } from '@/lib/recording-upload';
import {
  canDiscardQueuedRecordings, deleteStoredRecording, discardStoredRecording, readStoredRecordingBlob, saveStoredRecording, updateStoredRecording,
  type StoredRecording,
} from '@/lib/recording-queue';
import {
  chordsLengthError, emptyRecordingDetails, filenameWithoutExtension, formatDuration, recordingDetailsFrom, recordingDetailsPayload, toDatetimeLocalValue,
  type RecordingDetailsForm,
} from '@/lib/recording-format';
import { recordingCategories, recordingCategoryLabels, recordingsApi, recordingsQueryKeys, type Recording, type RecordingCategory } from '@/lib/recordings-api';
import { closeUploadNotices, kickRecordingUploads, pageUploadRequest, stopRecordingUploads, useStoredRecordings } from '@/hooks/use-recording-uploads';
import { useAudioCapture } from '@/hooks/use-audio-capture';
import { useAuth } from '@/contexts/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { NarrowOnly, PageBody, PageHeader, PageShell, PanelGroup, PanelHeader, PanelItem } from '@/components/layout/PageShell';
import { RecordingFields } from '@/components/recordings/RecordingFields';
import { DeviceRecordingRow, RecordingRow } from '@/components/recordings/RecordingRows';

type PendingAudio = {
  blob: Blob;
  filename: string;
  contentType: string;
  source: 'recorded' | 'imported';
  durationSeconds: number | null;
  // The copy kept on this device, when the browser allows it.
  jobId: string | null;
};

const EMPTY_RECORDINGS: Recording[] = [];
const AUDIO_FILE = /\.(mp3|m4a|mp4|wav|ogg|webm|flac|aac|aiff|aif)$/i;

const Recordings = () => {
  const { toast } = useToast();
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingAudio, setPendingAudio] = useState<PendingAudio | null>(null);
  const [pendingAudioUrl, setPendingAudioUrl] = useState<string | null>(null);
  const [details, setDetails] = useState<RecordingDetailsForm>(emptyRecordingDetails);
  const [search, setSearch] = useState(() => params.get('search') || '');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Recording | null>(null);
  const [editForm, setEditForm] = useState<RecordingDetailsForm>(emptyRecordingDetails);
  const [deleteTarget, setDeleteTarget] = useState<Recording | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<StoredRecording | null>(null);
  // Set when the server did not confirm cancelling the upload; asks again.
  const [discardUnconfirmed, setDiscardUnconfirmed] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const { recordings: storedRecordings, progress: storedProgress, available: deviceStorageAvailable } = useStoredRecordings();
  const otherStoredRecordings = storedRecordings.filter(item => item.id !== pendingAudio?.jobId);

  const categoryParam = params.get('category');
  const categoryFilter: 'all' | RecordingCategory = recordingCategories.includes(categoryParam as RecordingCategory) ? categoryParam as RecordingCategory : 'all';
  const tagFilter = params.get('tag') || '';
  const setFilter = (key: 'category' | 'tag', value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const capture = useAudioCapture({
    userId,
    draftTitle: details.title,
    onStart: () => setPendingAudio(null),
    onCaptured: audio => {
      setPendingAudio({ blob: audio.blob, filename: audio.filename, contentType: 'audio/wav', source: 'recorded', durationSeconds: audio.durationSeconds, jobId: audio.jobId });
      setDetails(prev => ({ ...prev, title: audio.title, recordedAt: toDatetimeLocalValue(audio.stoppedAt) }));
    },
  });

  const recordingFilters = useMemo(() => ({
    search,
    tag: tagFilter,
    category: categoryFilter === 'all' ? undefined : categoryFilter,
  }), [categoryFilter, search, tagFilter]);

  const recordingsQuery = useQuery({
    queryKey: recordingsQueryKeys.list(recordingFilters),
    queryFn: () => recordingsApi.list(recordingFilters),
  });
  const recordings = recordingsQuery.data ?? EMPTY_RECORDINGS;
  const allTags = useMemo(() => {
    const tags = new Set<string>(tagFilter ? [tagFilter] : []);
    for (const recording of recordings) for (const tagName of recording.tags || []) tags.add(tagName);
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [recordings, tagFilter]);

  useEffect(() => {
    if (!pendingAudio) {
      setPendingAudioUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(pendingAudio.blob);
    setPendingAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingAudio]);

  const resetForm = () => {
    setPendingAudio(null);
    setDetails(emptyRecordingDetails());
    setUploadProgress(null);
  };

  const saveAudio = useMutation({
    mutationFn: async (audio: PendingAudio): Promise<'queued' | 'uploaded'> => {
      // Refused before the recording is queued: a queued upload cannot be edited.
      const chordsError = chordsLengthError(details);
      if (chordsError) throw new Error(chordsError);
      const fields = recordingDetailsPayload(details);
      const jobDetails: RecordingUploadJob['details'] = {
        ...fields,
        title: fields.title || filenameWithoutExtension(audio.filename),
        original_filename: audio.filename,
        content_type: audio.contentType || audio.blob.type || 'audio/webm',
        duration_seconds: audio.durationSeconds,
        source: audio.source,
      };
      const id = audio.jobId ?? crypto.randomUUID();

      // Kept on the device first, so the upload can finish in the background
      // and survives a closed app.
      if (userId) {
        try {
          const queued = audio.jobId
            ? await updateStoredRecording(audio.jobId, { state: 'queued', details: jobDetails, error: null })
            : null;
          if (!queued) {
            const now = Date.now();
            await saveStoredRecording({
              id, userId, state: 'queued', details: jobDetails, size: audio.blob.size, bytesUploaded: 0,
              error: null, recovered: false, createdAt: now, updatedAt: now,
            }, audio.blob);
          }
          // Asks the browser not to clear the stored audio when space runs low.
          void navigator.storage?.persist?.().catch(() => false);
          kickRecordingUploads();
          return 'queued';
        } catch {
          // No device storage (for example some private windows). Upload
          // directly; the page has to stay open until it finishes.
        }
      }

      setUploadProgress(0);
      const outcome = await runRecordingUpload({ id, blob: audio.blob, details: jobDetails }, {
        request: pageUploadRequest,
        onProgress: bytes => setUploadProgress(Math.round((bytes / audio.blob.size) * 100)),
      });
      if (outcome.kind === 'done') return 'uploaded';
      if (outcome.kind === 'signed-out') throw new Error('Sign in again, then save the recording.');
      throw new Error(outcome.kind === 'paused' ? 'The upload was paused.' : outcome.error);
    },
    onSuccess: (result) => {
      resetForm();
      if (result === 'uploaded') {
        queryClient.invalidateQueries({ queryKey: recordingsQueryKeys.all });
        toast({ title: 'Recording saved' });
      } else {
        toast({ title: 'Uploading recording', description: 'It is kept on this device until the upload finishes. You can leave this page.' });
      }
    },
    onError: (error: Error) => {
      setUploadProgress(null);
      toast({ title: 'Recording upload failed', description: error.message, variant: 'destructive' });
    },
  });

  const discardPendingAudio = () => {
    const jobId = pendingAudio?.jobId;
    resetForm();
    if (jobId) void deleteStoredRecording(jobId).catch(() => {});
  };

  const continueStoredRecording = async (item: StoredRecording) => {
    const blob = await readStoredRecordingBlob(item.id).catch(() => null);
    if (!blob) {
      toast({ title: 'The audio of this recording is missing on this device', variant: 'destructive' });
      return;
    }
    setPendingAudio({
      blob,
      filename: item.details.original_filename,
      contentType: item.details.content_type,
      source: item.details.source,
      durationSeconds: item.details.duration_seconds,
      jobId: item.id,
    });
    setDetails({
      title: item.details.title,
      description: item.details.description || '',
      tags: (item.details.tags || []).join(', '),
      category: item.details.category || 'none',
      recordedAt: toDatetimeLocalValue(item.details.recorded_at || new Date(item.createdAt)),
      chords: item.details.metadata?.chords || '',
    });
  };

  const retryStoredRecording = async (item: StoredRecording) => {
    if (item.state === 'failed') await updateStoredRecording(item.id, { state: 'queued', error: null }).catch(() => null);
    kickRecordingUploads();
  };

  // A queued recording may be uploading from this page, another tab or the
  // service worker; discarding stops this page's uploads, waits for the upload
  // lock and cancels the server's partial copy before deleting it here.
  const discardRecording = async (item: StoredRecording, force: boolean) => {
    setDiscarding(true);
    try {
      if (item.state === 'draft') {
        await deleteStoredRecording(item.id);
        setDiscardTarget(null);
        return;
      }
      if (item.state === 'queued') stopRecordingUploads();
      const result = await discardStoredRecording(item.id, pageUploadRequest, { force });
      if (result.kind === 'not-cancelled') {
        setDiscardUnconfirmed(true);
        return;
      }
      setDiscardTarget(null);
      if (result.kind === 'busy' || result.kind === 'unsupported') {
        toast({ title: 'Recording is still uploading', description: 'Try discarding it again in a moment.', variant: 'destructive' });
        return;
      }
      void closeUploadNotices([`recording-upload:${item.id}`]);
      if (result.kind === 'uploaded') {
        queryClient.invalidateQueries({ queryKey: recordingsQueryKeys.all });
        toast({ title: 'Recording was already uploaded', description: `${item.details.title || 'The recording'} finished uploading before it could be discarded. Delete it from your recordings if you do not want it.` });
      }
    } catch {
      setDiscardTarget(null);
      toast({ title: 'Recording was not discarded', variant: 'destructive' });
    } finally {
      setDiscarding(false);
      if (item.state === 'queued') kickRecordingUploads();
    }
  };

  const downloadStoredRecording = async (item: StoredRecording) => {
    const blob = await readStoredRecordingBlob(item.id).catch(() => null);
    if (blob) await saveFile(blob, item.details.original_filename).catch(() => toast({ title: 'Could not save the recording', variant: 'destructive' }));
    else toast({ title: 'The audio of this recording is missing on this device', variant: 'destructive' });
  };

  const updateRecording = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Parameters<typeof recordingsApi.update>[1] }) => recordingsApi.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recordingsQueryKeys.all });
      setEditing(null);
      toast({ title: 'Recording updated' });
    },
    onError: (error: Error) => {
      toast({ title: 'Could not update recording', description: error.message, variant: 'destructive' });
    },
  });

  const deleteRecording = useMutation({
    mutationFn: (id: string) => recordingsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recordingsQueryKeys.all });
      setDeleteTarget(null);
      toast({ title: 'Recording deleted' });
    },
    onError: (error: Error) => {
      toast({ title: 'Could not delete recording', description: error.message, variant: 'destructive' });
    },
  });

  const handleImportFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !AUDIO_FILE.test(file.name)) {
      toast({ title: 'Please choose an audio file', variant: 'destructive' });
      return;
    }
    setPendingAudio({ blob: file, filename: file.name, contentType: file.type || 'audio/mpeg', source: 'imported', durationSeconds: null, jobId: null });
    setDetails({ ...emptyRecordingDetails(), title: filenameWithoutExtension(file.name) });
  };

  const downloadRecording = async (recording: Recording, exportMp3: boolean) => {
    try {
      setExportingId(recording.id);
      const query = exportMp3 ? 'download=1&format=mp3' : 'download=1';
      const { blob, filename } = await api.getBlob(`/recordings/${recording.id}/file?${query}`);
      await saveFile(blob, filename || recording.original_filename || `${recording.title}.${exportMp3 ? 'mp3' : 'audio'}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Download failed';
      toast({ title: exportMp3 ? 'MP3 export failed' : 'Download failed', description: message, variant: 'destructive' });
    } finally {
      setExportingId(null);
    }
  };

  const busy = capture.state !== 'idle';
  const filtered = !!(search || tagFilter || categoryFilter !== 'all');
  const scope = [categoryFilter === 'all' ? 'All recordings' : recordingCategoryLabels[categoryFilter], tagFilter].filter(Boolean).join(' · ');

  const panel = (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PanelHeader title="Recordings" action={<Button size="sm" onClick={() => void capture.start()} disabled={busy || !!pendingAudio}><Mic aria-hidden="true" />Record</Button>} />
      <PanelGroup>
        <PanelItem icon={Layers} active={categoryFilter === 'all'} onSelect={() => setFilter('category', null)}>All recordings</PanelItem>
        {recordingCategories.filter(item => item !== 'none').map(item => (
          <PanelItem key={item} icon={FileAudio} active={categoryFilter === item} onSelect={() => setFilter('category', item)}>{recordingCategoryLabels[item]}</PanelItem>
        ))}
      </PanelGroup>
      {allTags.length > 0 && (
        <PanelGroup label="Tags" className="border-t border-border pt-3">
          {allTags.map(tag => (
            <PanelItem key={tag} icon={Tag} active={tagFilter === tag} onSelect={() => setFilter('tag', tagFilter === tag ? null : tag)}>{tag}</PanelItem>
          ))}
        </PanelGroup>
      )}
      <PanelGroup className="border-t border-border pt-3">
        <PanelItem icon={Upload} onSelect={() => fileInputRef.current?.click()}>Import audio file</PanelItem>
      </PanelGroup>
    </div>
  );

  return (
    <PageShell panel={panel} panelLabel="Recording lists" panelId="recordings">
      <PageHeader title="Recordings" scope={scope}
        actions={!busy && !pendingAudio && <NarrowOnly><Button size="sm" aria-label="Record" onClick={() => void capture.start()}><Mic aria-hidden="true" /><span className="hidden sm:inline">Record</span></Button></NarrowOnly>}>
        <div className="flex h-12 items-center gap-2 px-4 md:px-6">
          <div className="relative w-full max-w-md">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search recordings" aria-label="Search recordings" className="h-9 pl-9" />
          </div>
        </div>
      </PageHeader>

      <PageBody width="reading">
        {busy && (
          <section aria-label="Recorder" className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-border px-4 py-3">
            <span aria-hidden="true" className={capture.state === 'recording' ? 'h-2.5 w-2.5 rounded-full bg-destructive motion-safe:animate-pulse' : 'h-2.5 w-2.5 rounded-full bg-muted-foreground'} />
            <span className="text-sm font-medium">{capture.state === 'recording' ? 'Recording' : 'Paused'}</span>
            <span className="font-mono text-sm tabular-nums text-muted-foreground" aria-live="off">{capture.elapsedSeconds > 0 ? formatDuration(capture.elapsedSeconds) : '0:00'}</span>
            <div className="ml-auto flex gap-2">
              {capture.state === 'recording'
                ? <Button variant="outline" size="sm" onClick={capture.pause}><Pause aria-hidden="true" />Pause</Button>
                : <Button variant="outline" size="sm" onClick={capture.resume}><Play aria-hidden="true" />Resume</Button>}
              <Button size="sm" onClick={() => void capture.stop()}><Square aria-hidden="true" />Stop</Button>
            </div>
          </section>
        )}

        {pendingAudio && (
          <section aria-labelledby="new-recording-heading" className="mb-8 space-y-4 rounded-lg border border-border p-4">
            <h2 id="new-recording-heading" className="text-base font-semibold">{pendingAudio.source === 'recorded' ? 'Save the recording' : 'Save the imported audio'}</h2>
            {pendingAudioUrl && <audio controls className="w-full" src={pendingAudioUrl} />}
            <RecordingFields id="recording" value={details} onChange={setDetails} />
            {uploadProgress !== null && <Progress value={uploadProgress} />}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={discardPendingAudio} disabled={saveAudio.isPending}>Discard</Button>
              <Button onClick={() => saveAudio.mutate(pendingAudio)} disabled={saveAudio.isPending || !details.title.trim()}>
                {saveAudio.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Save recording
              </Button>
            </div>
          </section>
        )}

        {otherStoredRecordings.length > 0 && (
          <section aria-labelledby="device-recordings-heading" className="mb-8">
            <h2 id="device-recordings-heading" className="text-sm font-medium">On this device</h2>
            <p className="mb-1 text-xs text-muted-foreground">Not on the server yet. Uploads continue in the background.</p>
            <ul className="border-t border-border">
              {otherStoredRecordings.map(item => (
                <DeviceRecordingRow key={item.id} item={item} bytesUploaded={storedProgress[item.id] ?? item.bytesUploaded}
                  canContinue={!pendingAudio && !busy} canDiscard={item.state !== 'queued' || canDiscardQueuedRecordings()}
                  onContinue={() => void continueStoredRecording(item)} onRetry={() => void retryStoredRecording(item)}
                  onDownload={() => void downloadStoredRecording(item)} onDiscard={() => { setDiscardUnconfirmed(false); setDiscardTarget(item); }} />
              ))}
            </ul>
          </section>
        )}

        {!deviceStorageAvailable && (
          <p className="mb-6 text-sm text-muted-foreground">This browser does not allow storing recordings on the device. Keep the app open until an upload finishes.</p>
        )}

        {recordingsQuery.isLoading ? <LoadingState label="Loading recordings…" />
          : recordingsQuery.error ? <ErrorState title="Could not load recordings" error={recordingsQuery.error} onRetry={() => void recordingsQuery.refetch()} retrying={recordingsQuery.isFetching} />
          : recordings.length === 0 ? (
            <EmptyState icon={FileAudio} title={filtered ? 'No recordings match' : 'No recordings yet'}
              description={filtered ? 'Try another search, category or tag.' : 'Record with the microphone, or import an audio file.'}
              action={!filtered && !busy && !pendingAudio ? <Button variant="outline" onClick={() => fileInputRef.current?.click()}><Upload aria-hidden="true" />Import audio file</Button> : undefined} />
          ) : (
            <section aria-label="Library">
              {(otherStoredRecordings.length > 0 || pendingAudio) && <h2 className="mb-1 text-sm font-medium">Library</h2>}
              <ul className="border-t border-border">
                {recordings.map(recording => (
                  <RecordingRow key={recording.id} recording={recording} playing={playingId === recording.id} exporting={exportingId === recording.id} activeTag={tagFilter}
                    onPlay={() => setPlayingId(playingId === recording.id ? null : recording.id)}
                    onEdit={() => { setEditing(recording); setEditForm(recordingDetailsFrom(recording)); }}
                    onDownload={mp3 => void downloadRecording(recording, mp3)} onDelete={() => setDeleteTarget(recording)}
                    onTag={tag => setFilter('tag', tagFilter === tag ? null : tag)} />
                ))}
              </ul>
            </section>
          )}
      </PageBody>

      <input ref={fileInputRef} type="file" accept="audio/*,.mp3,.m4a,.mp4,.wav,.ogg,.webm,.flac,.aac,.aiff,.aif" className="hidden"
        onChange={event => { handleImportFile(event.target.files?.[0]); event.target.value = ''; }} />

      <Dialog open={!!editing} onOpenChange={open => { if (!open) setEditing(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit recording</DialogTitle></DialogHeader>
          <form className="space-y-4" onSubmit={event => {
            event.preventDefault();
            if (editing) updateRecording.mutate({ id: editing.id, payload: recordingDetailsPayload(editForm) });
          }}>
            <RecordingFields id="edit-recording" value={editForm} onChange={setEditForm} />
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" disabled={updateRecording.isPending || !editForm.title.trim()}>
                {updateRecording.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!discardTarget} onOpenChange={open => { if (!open && !discarding) setDiscardTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{discardUnconfirmed ? 'Discard anyway?' : 'Discard recording?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {discardUnconfirmed
                ? 'The server did not confirm cancelling the upload. Discarding now deletes the audio on this device; the part already uploaded is removed when the upload expires, and you may still get a notice that it stalled.'
                : discardTarget?.state === 'queued'
                  ? `${discardTarget.details.title || 'This recording'} has not finished uploading. Discarding cancels the upload and deletes its audio for good.`
                  : `${discardTarget?.details.title || 'This recording'} is only on this device. Discarding deletes its audio for good.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discarding}>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} disabled={discarding}
              onClick={event => { event.preventDefault(); if (discardTarget) void discardRecording(discardTarget, discardUnconfirmed); }}>
              {discarding && <Loader2 aria-hidden="true" className="animate-spin" />}{discardUnconfirmed ? 'Discard anyway' : 'Discard'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete recording?</AlertDialogTitle>
            <AlertDialogDescription>This permanently deletes {deleteTarget?.title || 'this recording'} and its stored audio file.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => { if (deleteTarget) deleteRecording.mutate(deleteTarget.id); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
};

export default Recordings;
