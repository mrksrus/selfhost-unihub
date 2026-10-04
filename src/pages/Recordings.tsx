import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { createPcm16WavBlob } from '@/lib/wav';
import { runRecordingUpload, type RecordingUploadJob } from '@/lib/recording-upload';
import {
  appendCaptureBatch,
  createCapture,
  deleteCapture,
  deleteStoredRecording,
  discardStoredRecording,
  finishCapture,
  listCaptures,
  readStoredRecordingBlob,
  recoverCapture,
  saveStoredRecording,
  updateStoredRecording,
  type StoredRecording,
} from '@/lib/recording-queue';
import { closeUploadNotices, kickRecordingUploads, pageUploadRequest, stopRecordingUploads, useStoredRecordings } from '@/hooks/use-recording-uploads';
import { useAuth } from '@/contexts/useAuth';
import { RecordingPlayer } from '@/components/recordings/RecordingPlayer';
import {
  recordingCategories,
  recordingCategoryLabels,
  recordingsApi,
  recordingsQueryKeys,
  type Recording,
  type RecordingCategory,
} from '@/lib/recordings-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import {
  Download,
  Edit,
  HardDrive,
  FileAudio,
  Loader2,
  Mic,
  Pause,
  Play,
  Search,
  Square,
  Tag,
  Trash2,
  Upload,
} from 'lucide-react';

type PendingAudio = {
  blob: Blob;
  filename: string;
  contentType: string;
  source: 'recorded' | 'imported';
  durationSeconds: number | null;
  // The copy kept on this device, when the browser allows it.
  jobId: string | null;
};

// Audio of a running recording is written to the device this often, so a
// crash or a closed app loses at most this much.
const CAPTURE_FLUSH_MS = 2000;
const VOICE_PROCESSING = ['autoGainControl', 'noiseSuppression', 'echoCancellation'] as const;
const VOICE_PROCESSING_LABELS: Record<typeof VOICE_PROCESSING[number], string> = {
  autoGainControl: 'automatic volume',
  noiseSuppression: 'noise suppression',
  echoCancellation: 'echo cancellation',
};
const EMPTY_RECORDINGS: Recording[] = [];

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(value: number | null) {
  if (!value || value < 0) return 'Unknown length';
  const total = Math.round(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function parseTags(value: string) {
  const seen = new Set<string>();
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

function filenameWithoutExtension(filename: string) {
  return filename.replace(/\.[^.]+$/, '').trim() || 'Recording';
}

function toDatetimeLocalValue(value: string | Date | null | undefined) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function datetimeLocalToIso(value: string) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function formatRecordedAt(value: string | null | undefined) {
  if (!value) return 'No recording date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No recording date';
  return date.toLocaleString();
}

function captureLockName(id: string) {
  return `unihub-capture:${id}`;
}

// Automatic volume control makes the level of music rise and fall. The
// browser may ignore the request in getUserMedia, so check what it applied.
async function disableVoiceProcessing(track: MediaStreamTrack) {
  const active = () => {
    const settings = track.getSettings();
    return VOICE_PROCESSING.filter(key => settings[key] === true);
  };
  if (active().length) {
    await track.applyConstraints({ autoGainControl: false, noiseSuppression: false, echoCancellation: false }).catch(() => {});
  }
  return active();
}

function storedRecordingStatus(item: StoredRecording, bytesUploaded: number) {
  if (item.state === 'draft') return item.recovered ? 'Recovered, not saved yet' : 'Not saved yet';
  if (item.state === 'failed') return `Upload refused: ${item.error || 'unknown error'}`;
  const percent = item.size ? Math.round((bytesUploaded / item.size) * 100) : 0;
  return item.error ? `Waiting to upload (${percent}%): ${item.error}` : `Uploading (${percent}%)`;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const Recordings = () => {
  const { toast } = useToast();
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recorderWorkletRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const pcmChunksRef = useRef<ArrayBuffer[]>([]);
  const pcmSampleCountRef = useRef(0);
  const pcmSampleRateRef = useRef(44100);
  const workletStoppedResolveRef = useRef<(() => void) | null>(null);
  const stopInProgressRef = useRef(false);
  const captureIdRef = useRef<string | null>(null);
  const captureBatchRef = useRef<ArrayBuffer[]>([]);
  const captureBatchSamplesRef = useRef(0);
  const captureWritesRef = useRef<Promise<void>>(Promise.resolve());
  const captureFailedRef = useRef(false);
  const captureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureReleaseRef = useRef<(() => void) | null>(null);
  const interruptionShownRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const pausedMsRef = useRef(0);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'paused'>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [pendingAudio, setPendingAudio] = useState<PendingAudio | null>(null);
  const [pendingAudioUrl, setPendingAudioUrl] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [category, setCategory] = useState<RecordingCategory>('none');
  const [recordedAt, setRecordedAt] = useState(() => toDatetimeLocalValue(new Date()));
  const [musicChords, setMusicChords] = useState('');
  const [search, setSearch] = useState(() => searchParams.get('search') || '');
  const [tagFilter, setTagFilter] = useState(() => searchParams.get('tag') || '');
  const [categoryFilter, setCategoryFilter] = useState<'all' | RecordingCategory>(() => {
    const raw = searchParams.get('category');
    return recordingCategories.includes(raw as RecordingCategory) ? raw as RecordingCategory : 'all';
  });
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [editingRecording, setEditingRecording] = useState<Recording | null>(null);
  const [editForm, setEditForm] = useState({
    title: '',
    description: '',
    tags: '',
    category: 'none' as RecordingCategory,
    recorded_at: '',
    chords: '',
  });
  const [deleteTarget, setDeleteTarget] = useState<Recording | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<StoredRecording | null>(null);
  // Set when the server did not confirm cancelling the upload; asks again.
  const [discardUnconfirmed, setDiscardUnconfirmed] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const {
    recordings: storedRecordings,
    progress: storedProgress,
    available: deviceStorageAvailable,
  } = useStoredRecordings();
  const otherStoredRecordings = storedRecordings.filter(item => item.id !== pendingAudio?.jobId);

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
    const tags = new Set<string>();
    for (const recording of recordings) {
      for (const tagName of recording.tags || []) tags.add(tagName);
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [recordings]);

  useEffect(() => {
    if (recordingState === 'idle') return;
    const timer = window.setInterval(() => {
      if (!startedAtRef.current) return;
      const now = recordingState === 'paused' && pausedAtRef.current ? pausedAtRef.current : Date.now();
      const elapsed = Math.max(0, now - startedAtRef.current - pausedMsRef.current);
      setElapsedSeconds(elapsed / 1000);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recordingState]);

  useEffect(() => () => {
    // Leaving the page mid-recording keeps what was captured. The next visit
    // recovers it as a draft.
    persistCaptureBatch();
    if (captureTimerRef.current) clearInterval(captureTimerRef.current);
    const release = captureReleaseRef.current;
    void captureWritesRef.current.finally(() => release?.());
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderWorkletRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    void audioContextRef.current?.close();
  }, []);

  useEffect(() => {
    if (!pendingAudio) {
      setPendingAudioUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(pendingAudio.blob);
    setPendingAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingAudio]);

  // Interrupted recordings (closed app, crash, reload) are rebuilt from the
  // audio written while recording. A capture still locked belongs to a
  // recording running in another tab.
  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    const recover = async (capture: Awaited<ReturnType<typeof listCaptures>>[number]) => {
      const startedAt = new Date(capture.startedAt);
      const job = await recoverCapture(capture, {
        title: `Recovered recording ${startedAt.toLocaleString()}`,
        original_filename: `recording-${startedAt.toISOString().replace(/[:.]/g, '-')}.wav`,
        content_type: 'audio/wav',
        duration_seconds: null,
        source: 'recorded',
        category: 'none',
        recorded_at: startedAt.toISOString(),
        metadata: {},
        tags: [],
      });
      if (job && !cancelled) {
        toast({ title: 'Interrupted recording recovered', description: 'It is listed under "On this device". Check it and save it.' });
      }
    };
    void (async () => {
      for (const capture of await listCaptures(userId)) {
        if (cancelled) return;
        if (navigator.locks) {
          await navigator.locks.request(captureLockName(capture.id), { ifAvailable: true }, async lock => {
            if (lock) await recover(capture);
          });
        } else if (Date.now() - capture.updatedAt > 60 * 60 * 1000) {
          await recover(capture);
        }
      }
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [toast, userId]);

  useEffect(() => {
    if (recordingState === 'idle') return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [recordingState]);

  const resetForm = () => {
    setPendingAudio(null);
    setTitle('');
    setDescription('');
    setTagInput('');
    setCategory('none');
    setRecordedAt(toDatetimeLocalValue(new Date()));
    setMusicChords('');
    setUploadProgress(null);
  };

  const saveAudio = useMutation({
    mutationFn: async (audio: PendingAudio): Promise<'queued' | 'uploaded'> => {
      const details: RecordingUploadJob['details'] = {
        title: title.trim() || filenameWithoutExtension(audio.filename),
        description: description.trim(),
        original_filename: audio.filename,
        content_type: audio.contentType || audio.blob.type || 'audio/webm',
        duration_seconds: audio.durationSeconds,
        source: audio.source,
        category,
        recorded_at: datetimeLocalToIso(recordedAt),
        metadata: category === 'music' ? { chords: musicChords } : {},
        tags: parseTags(tagInput),
      };
      const id = audio.jobId ?? crypto.randomUUID();

      // Kept on the device first, so the upload can finish in the background
      // and survives a closed app.
      if (userId) {
        try {
          const queued = audio.jobId
            ? await updateStoredRecording(audio.jobId, { state: 'queued', details, error: null })
            : null;
          if (!queued) {
            const now = Date.now();
            await saveStoredRecording({
              id, userId, state: 'queued', details, size: audio.blob.size, bytesUploaded: 0,
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
      const outcome = await runRecordingUpload({ id, blob: audio.blob, details }, {
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
    setTitle(item.details.title);
    setDescription(item.details.description || '');
    setTagInput((item.details.tags || []).join(', '));
    setCategory(item.details.category || 'none');
    setRecordedAt(toDatetimeLocalValue(item.details.recorded_at || new Date(item.createdAt)));
    setMusicChords(item.details.metadata?.chords || '');
  };

  const retryStoredRecording = async (item: StoredRecording) => {
    await updateStoredRecording(item.id, { state: 'queued', error: null }).catch(() => null);
    kickRecordingUploads();
  };

  // A queued recording may be uploading from this page, another tab or the
  // service worker; discarding stops this page's uploads, waits for the upload
  // lock and cancels the server's partial copy before deleting it here.
  const discardRecording = async (item: StoredRecording, force: boolean) => {
    setDiscarding(true);
    try {
      if (item.state !== 'queued') {
        await deleteStoredRecording(item.id);
        setDiscardTarget(null);
        return;
      }
      stopRecordingUploads();
      const result = await discardStoredRecording(item.id, pageUploadRequest, { force });
      if (result.kind === 'not-cancelled') {
        setDiscardUnconfirmed(true);
        return;
      }
      setDiscardTarget(null);
      if (result.kind === 'busy') {
        toast({ title: 'Recording is still uploading', description: 'Try discarding it again in a moment.', variant: 'destructive' });
        return;
      }
      void closeUploadNotices([`recording-upload:${item.id}`]);
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
    if (blob) saveBlob(blob, item.details.original_filename);
    else toast({ title: 'The audio of this recording is missing on this device', variant: 'destructive' });
  };

  const updateRecording = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Parameters<typeof recordingsApi.update>[1] }) => recordingsApi.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recordingsQueryKeys.all });
      setEditingRecording(null);
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

  // Writes the audio received since the last write. Writes run one after the
  // other so batches keep their order.
  function persistCaptureBatch() {
    const captureId = captureIdRef.current;
    if (!captureId || captureFailedRef.current || !captureBatchRef.current.length) return captureWritesRef.current;
    const batch = new Blob(captureBatchRef.current);
    const samples = captureBatchSamplesRef.current;
    captureBatchRef.current = [];
    captureBatchSamplesRef.current = 0;
    captureWritesRef.current = captureWritesRef.current
      .then(() => appendCaptureBatch(captureId, batch, samples))
      .catch(() => { captureFailedRef.current = true; });
    return captureWritesRef.current;
  }

  // Holds a lock for the whole recording, so a recovery in another tab
  // leaves this capture alone.
  const startCapture = async (sampleRate: number) => {
    captureIdRef.current = null;
    captureBatchRef.current = [];
    captureBatchSamplesRef.current = 0;
    captureFailedRef.current = false;
    captureWritesRef.current = Promise.resolve();
    if (!userId) return;
    const captureId = crypto.randomUUID();
    try {
      if (navigator.locks) {
        await new Promise<void>((acquired) => {
          void navigator.locks.request(captureLockName(captureId), () => {
            acquired();
            return new Promise<void>((release) => { captureReleaseRef.current = release; });
          });
        });
      }
      const now = Date.now();
      await createCapture({ id: captureId, userId, sampleRate, sampleCount: 0, batches: 0, startedAt: now, updatedAt: now });
      captureIdRef.current = captureId;
      captureTimerRef.current = setInterval(() => void persistCaptureBatch(), CAPTURE_FLUSH_MS);
    } catch {
      captureReleaseRef.current?.();
      captureReleaseRef.current = null;
      toast({ title: 'Recording is kept in memory only', description: 'This browser does not allow storing it on the device. Keep the app open until you save it.' });
    }
  };

  const endCapture = () => {
    if (captureTimerRef.current) clearInterval(captureTimerRef.current);
    captureTimerRef.current = null;
    captureReleaseRef.current?.();
    captureReleaseRef.current = null;
    captureIdRef.current = null;
    captureBatchRef.current = [];
    captureBatchSamplesRef.current = 0;
  };

  const releaseRecordingResources = async () => {
    recorderWorkletRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    await audioContextRef.current?.close().catch(() => {});
    recorderWorkletRef.current = null;
    audioSourceRef.current = null;
    silentGainRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
  };

  const startRecording = async () => {
    const AudioContextClass = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextClass || typeof AudioWorkletNode === 'undefined') {
      toast({ title: 'Recording is not available in this browser', variant: 'destructive' });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
      });
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const processing = track ? await disableVoiceProcessing(track) : [];
      if (processing.length) {
        toast({
          title: 'The browser keeps audio processing on',
          description: `It did not allow turning off ${processing.map(key => VOICE_PROCESSING_LABELS[key]).join(', ')}. The volume may change on its own during the recording.`,
        });
      }
      // Keep the microphone's rate where available so capture does not need an
      // extra resampling step. WAV records the actual context rate in its header.
      const sampleRate = track?.getSettings().sampleRate;
      const audioContext = new AudioContextClass({
        ...(sampleRate ? { sampleRate } : {}),
        latencyHint: 'balanced',
      });
      audioContextRef.current = audioContext;
      await audioContext.audioWorklet.addModule('/audio-recorder-worklet.js');
      const source = audioContext.createMediaStreamSource(stream);
      audioSourceRef.current = source;
      const worklet = new AudioWorkletNode(audioContext, 'pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      recorderWorkletRef.current = worklet;
      const silentGain = audioContext.createGain();
      silentGainRef.current = silentGain;
      silentGain.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(audioContext.destination);
      await audioContext.resume();

      pcmChunksRef.current = [];
      pcmSampleCountRef.current = 0;
      pcmSampleRateRef.current = audioContext.sampleRate;
      startedAtRef.current = Date.now();
      pausedAtRef.current = null;
      pausedMsRef.current = 0;
      stopInProgressRef.current = false;
      setElapsedSeconds(0);
      setPendingAudio(null);
      interruptionShownRef.current = false;
      await startCapture(audioContext.sampleRate);

      // A phone call or another app can take the microphone or suspend audio.
      // Keep what was recorded and tell the user.
      if (track) track.onended = () => {
        toast({ title: 'The microphone was turned off', description: 'The recording was stopped. What was recorded so far is kept.', variant: 'destructive' });
        void stopRecording();
      };
      audioContext.onstatechange = () => {
        if (audioContext.state === 'running' || audioContext.state === 'closed' || stopInProgressRef.current) return;
        void audioContext.resume().catch(() => {});
        if (!interruptionShownRef.current) {
          interruptionShownRef.current = true;
          toast({ title: 'Recording was interrupted', description: 'The system paused audio. The recording may have a gap.', variant: 'destructive' });
        }
      };

      worklet.port.onmessage = (event: MessageEvent<{
        type?: string;
        buffer?: ArrayBuffer;
        samples?: number;
      }>) => {
        if (event.data.type === 'pcm' && event.data.buffer && event.data.samples) {
          pcmChunksRef.current.push(event.data.buffer);
          pcmSampleCountRef.current += event.data.samples;
          if (captureIdRef.current) {
            captureBatchRef.current.push(event.data.buffer);
            captureBatchSamplesRef.current += event.data.samples;
          }
        } else if (event.data.type === 'stopped') {
          workletStoppedResolveRef.current?.();
          workletStoppedResolveRef.current = null;
        }
      };
      setRecordingState('recording');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Microphone access failed';
      toast({ title: 'Could not start recording', description: message, variant: 'destructive' });
      const captureId = captureIdRef.current;
      endCapture();
      if (captureId) void deleteCapture(captureId).catch(() => {});
      await releaseRecordingResources();
    }
  };

  const pauseRecording = () => {
    const worklet = recorderWorkletRef.current;
    if (!worklet || recordingState !== 'recording') return;
    worklet.port.postMessage({ type: 'pause' });
    pausedAtRef.current = Date.now();
    setRecordingState('paused');
  };

  const resumeRecording = () => {
    const worklet = recorderWorkletRef.current;
    if (!worklet || recordingState !== 'paused') return;
    if (pausedAtRef.current) pausedMsRef.current += Date.now() - pausedAtRef.current;
    pausedAtRef.current = null;
    worklet.port.postMessage({ type: 'resume' });
    setRecordingState('recording');
  };

  const stopRecording = async () => {
    const worklet = recorderWorkletRef.current;
    if (!worklet || stopInProgressRef.current) return;
    stopInProgressRef.current = true;

    try {
      const stopped = new Promise<void>((resolve) => {
        workletStoppedResolveRef.current = resolve;
      });
      worklet.port.postMessage({ type: 'stop' });
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let stopConfirmed = true;
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          stopTimer = setTimeout(() => { stopConfirmed = false; resolve(); }, 5000);
        }),
      ]);
      clearTimeout(stopTimer);
      // Detach before creating the Blob so late messages cannot add samples to a
      // preview that has already been finalized. Keep captured audio on timeout.
      worklet.port.onmessage = null;
      if (!stopConfirmed) {
        toast({ title: 'Please check the recording preview', description: 'The recorder took too long to stop. The final moment of audio may be missing.', variant: 'destructive' });
      }

      const sampleCount = pcmSampleCountRef.current;
      const sampleRate = pcmSampleRateRef.current;
      const blob = createPcm16WavBlob(pcmChunksRef.current, sampleRate, sampleCount);
      pcmChunksRef.current = [];
      pcmSampleCountRef.current = 0;
      const stoppedAt = new Date();
      const filename = `recording-${stoppedAt.toISOString().replace(/[:.]/g, '-')}.wav`;
      const recordingTitle = title || `Recording ${stoppedAt.toLocaleString()}`;
      const durationSeconds = sampleCount / sampleRate;

      // The finished file replaces the capture on the device as a draft, so
      // it survives until it is saved or discarded.
      const captureId = captureIdRef.current;
      let jobId: string | null = null;
      if (captureId && userId && !captureFailedRef.current) {
        if (captureTimerRef.current) clearInterval(captureTimerRef.current);
        await captureWritesRef.current;
        try {
          await finishCapture(captureId, {
            id: captureId,
            userId,
            state: 'draft',
            details: {
              title: recordingTitle,
              original_filename: filename,
              content_type: 'audio/wav',
              duration_seconds: durationSeconds,
              source: 'recorded',
              category: 'none',
              recorded_at: stoppedAt.toISOString(),
              metadata: {},
              tags: [],
            },
            size: blob.size,
            bytesUploaded: 0,
            error: null,
            recovered: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }, blob);
          jobId = captureId;
        } catch {
          // The capture stays and is recovered on the next visit.
        }
      } else if (captureId) {
        // Writing failed part way. The full recording is in memory, so the
        // partial copy would only come back as a broken duplicate.
        void deleteCapture(captureId).catch(() => {});
      }
      endCapture();
      setPendingAudio({
        blob,
        filename,
        contentType: 'audio/wav',
        source: 'recorded',
        durationSeconds,
        jobId,
      });
      setTitle(recordingTitle);
      setRecordedAt(toDatetimeLocalValue(stoppedAt));
      setRecordingState('idle');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Could not finish WAV recording';
      toast({ title: 'Recording failed', description: message, variant: 'destructive' });
    } finally {
      workletStoppedResolveRef.current = null;
      setRecordingState('idle');
      endCapture();
      await releaseRecordingResources();
      stopInProgressRef.current = false;
    }
  };

  const handleImportFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|mp4|wav|ogg|webm|flac|aac|aiff|aif)$/i.test(file.name)) {
      toast({ title: 'Please choose an audio file', variant: 'destructive' });
      return;
    }
    setPendingAudio({
      blob: file,
      filename: file.name,
      contentType: file.type || 'audio/mpeg',
      source: 'imported',
      durationSeconds: null,
      jobId: null,
    });
    setTitle(filenameWithoutExtension(file.name));
    setRecordedAt(toDatetimeLocalValue(new Date()));
  };

  const downloadRecording = async (recording: Recording, exportMp3 = false) => {
    try {
      setExportingId(recording.id);
      const query = exportMp3 ? 'download=1&format=mp3' : 'download=1';
      const { blob, filename } = await api.getBlob(`/recordings/${recording.id}/file?${query}`);
      saveBlob(blob, filename || recording.original_filename || `${recording.title}.${exportMp3 ? 'mp3' : 'audio'}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Download failed';
      toast({ title: exportMp3 ? 'MP3 export failed' : 'Download failed', description: message, variant: 'destructive' });
    } finally {
      setExportingId(null);
    }
  };

  const openEditDialog = (recording: Recording) => {
    setEditingRecording(recording);
    setEditForm({
      title: recording.title,
      description: recording.description || '',
      tags: recording.tags.join(', '),
      category: recording.category || 'none',
      recorded_at: toDatetimeLocalValue(recording.recorded_at || recording.created_at),
      chords: recording.metadata?.chords || '',
    });
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Recordings</h1>
        <p className="text-muted-foreground">Record, import, tag, and export audio files</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent/10">
                <Mic className="h-5 w-5 text-accent" />
              </div>
              <div>
                <CardTitle className="text-lg">Recorder</CardTitle>
                <CardDescription>Uncompressed WAV, kept on this device until the upload finishes</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              {recordingState === 'idle' ? (
                <Button onClick={startRecording}>
                  <Mic className="h-4 w-4 mr-2" />
                  Record
                </Button>
              ) : (
                <>
                  {recordingState === 'recording' ? (
                    <Button variant="outline" onClick={pauseRecording}>
                      <Pause className="h-4 w-4 mr-2" />
                      Pause
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={resumeRecording}>
                      <Play className="h-4 w-4 mr-2" />
                      Resume
                    </Button>
                  )}
                  <Button variant="destructive" onClick={stopRecording}>
                    <Square className="h-4 w-4 mr-2" />
                    Stop
                  </Button>
                </>
              )}
              <span className="font-mono text-sm text-muted-foreground">{elapsedSeconds > 0 ? formatDuration(elapsedSeconds) : '0:00'}</span>
              {recordingState !== 'idle' && (
                <Badge variant={recordingState === 'recording' ? 'default' : 'secondary'}>
                  {recordingState}
                </Badge>
              )}
            </div>

            {pendingAudio && (
              <div className="rounded-md border border-border p-4 space-y-4">
                {pendingAudioUrl && <audio controls className="w-full" src={pendingAudioUrl} />}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="recording-title">Name</Label>
                    <Input id="recording-title" value={title} onChange={(event) => setTitle(event.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recording-tags">Tags</Label>
                    <Input
                      id="recording-tags"
                      value={tagInput}
                      onChange={(event) => setTagInput(event.target.value)}
                      placeholder="meeting, client, idea"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recording-category">Category</Label>
                    <Select value={category} onValueChange={(value) => setCategory(value as RecordingCategory)}>
                      <SelectTrigger id="recording-category">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {recordingCategories.map((item) => (
                          <SelectItem key={item} value={item}>{recordingCategoryLabels[item]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recording-recorded-at">Recorded</Label>
                    <Input
                      id="recording-recorded-at"
                      type="datetime-local"
                      value={recordedAt}
                      onChange={(event) => setRecordedAt(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="recording-description">Description</Label>
                    <Textarea
                      id="recording-description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      rows={3}
                    />
                  </div>
                  {category === 'music' && (
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="recording-chords">Chords</Label>
                      <Textarea
                        id="recording-chords"
                        value={musicChords}
                        onChange={(event) => setMusicChords(event.target.value)}
                        placeholder="C  G  Am  F"
                        rows={4}
                      />
                    </div>
                  )}
                </div>
                {uploadProgress !== null && <Progress value={uploadProgress} />}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={discardPendingAudio} disabled={saveAudio.isPending}>
                    Discard
                  </Button>
                  <Button onClick={() => saveAudio.mutate(pendingAudio)} disabled={saveAudio.isPending || !title.trim()}>
                    {saveAudio.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Save recording
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent/10">
                <Upload className="h-5 w-5 text-accent" />
              </div>
              <div>
                <CardTitle className="text-lg">Import Audio</CardTitle>
                <CardDescription>MP3, M4A, WAV, OGG, WebM, FLAC, AAC, or AIFF</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.mp3,.m4a,.mp4,.wav,.ogg,.webm,.flac,.aac,.aiff,.aif"
              className="hidden"
              onChange={(event) => handleImportFile(event.target.files?.[0])}
            />
            <Button variant="outline" className="w-full" onClick={() => fileInputRef.current?.click()}>
              <FileAudio className="h-4 w-4 mr-2" />
              Choose audio file
            </Button>
          </CardContent>
        </Card>
      </div>

      {otherStoredRecordings.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent/10">
                <HardDrive className="h-5 w-5 text-accent" />
              </div>
              <div>
                <CardTitle className="text-lg">On this device</CardTitle>
                <CardDescription>Not on the server yet. Uploads continue in the background.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {otherStoredRecordings.map((item) => {
              const bytesUploaded = storedProgress[item.id] ?? item.bytesUploaded;
              return (
                <div key={item.id} className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <h2 className="font-semibold text-foreground truncate">{item.details.title}</h2>
                      <p className="text-xs text-muted-foreground">
                        {formatRecordedAt(item.details.recorded_at || new Date(item.createdAt).toISOString())} • {formatBytes(item.size)} • {formatDuration(item.details.duration_seconds)}
                      </p>
                      <p className={item.state === 'failed' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
                        {storedRecordingStatus(item, bytesUploaded)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 sm:justify-end">
                      {item.state === 'draft' && (
                        <Button size="sm" onClick={() => void continueStoredRecording(item)} disabled={!!pendingAudio || recordingState !== 'idle'}>
                          <Edit className="h-4 w-4 mr-2" />
                          Continue
                        </Button>
                      )}
                      {item.state === 'failed' && (
                        <Button size="sm" variant="outline" onClick={() => void retryStoredRecording(item)}>
                          <Upload className="h-4 w-4 mr-2" />
                          Try again
                        </Button>
                      )}
                      {item.state === 'queued' && item.error && (
                        <Button size="sm" variant="outline" onClick={kickRecordingUploads}>
                          <Upload className="h-4 w-4 mr-2" />
                          Retry now
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => void downloadStoredRecording(item)}>
                        <Download className="h-4 w-4 mr-2" />
                        Download
                      </Button>
                      <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => { setDiscardUnconfirmed(false); setDiscardTarget(item); }}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Discard
                      </Button>
                    </div>
                  </div>
                  {item.state === 'queued' && <Progress value={item.size ? (bytesUploaded / item.size) * 100 : 0} />}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {!deviceStorageAvailable && (
        <p className="text-sm text-muted-foreground">
          This browser does not allow storing recordings on the device. Keep the app open until an upload finishes.
        </p>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-lg">Library</CardTitle>
              <CardDescription>{recordings.length} matching recordings</CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search recordings"
                  className="pl-9 sm:w-64"
                />
              </div>
              <Input
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value)}
                placeholder="Filter tag"
                className="sm:w-40"
              />
            </div>
          </div>
          <Tabs value={categoryFilter} onValueChange={(value) => setCategoryFilter(value as 'all' | RecordingCategory)} className="pt-2">
            <TabsList className="flex h-auto flex-wrap justify-start">
              <TabsTrigger value="all">All</TabsTrigger>
              {recordingCategories.map((item) => (
                <TabsTrigger key={item} value={item}>{recordingCategoryLabels[item]}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {allTags.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2">
              {allTags.map((tagName) => (
                <button key={tagName} type="button" onClick={() => setTagFilter(tagName)}>
                  <Badge variant={tagFilter === tagName ? 'default' : 'secondary'}>{tagName}</Badge>
                </button>
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {recordingsQuery.isLoading ? (
            <LoadingState label="Loading recordings…" />
          ) : recordingsQuery.error ? (
            <ErrorState
              title="Could not load recordings"
              error={recordingsQuery.error}
              onRetry={() => void recordingsQuery.refetch()}
              retrying={recordingsQuery.isFetching}
            />
          ) : recordings.length === 0 ? (
            <EmptyState
              icon={FileAudio}
              title={search || tagFilter || categoryFilter !== 'all' ? 'No recordings found' : 'No recordings yet'}
              description={search || tagFilter || categoryFilter !== 'all' ? 'Try a different search or filter.' : undefined}
            />
          ) : (
            <div className="space-y-3">
              {recordings.map((recording) => (
                <div key={recording.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <h2 className="font-semibold text-foreground truncate">{recording.title}</h2>
                        <p className="text-xs text-muted-foreground">
                          {formatRecordedAt(recording.recorded_at)} • {formatBytes(recording.size_bytes)} • {formatDuration(recording.duration_seconds)} • {recording.source}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant={recording.category === 'none' ? 'outline' : 'default'}>
                          {recordingCategoryLabels[recording.category || 'none']}
                        </Badge>
                      </div>
                      {recording.description && <p className="text-sm text-muted-foreground">{recording.description}</p>}
                      {recording.category === 'music' && recording.metadata?.chords && (
                        <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm text-foreground font-sans">
                          {recording.metadata.chords}
                        </pre>
                      )}
                      <RecordingPlayer id={recording.id} />
                      {recording.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {recording.tags.map((tagName) => (
                            <Badge key={tagName} variant="secondary" className="gap-1">
                              <Tag className="h-3 w-3" />
                              {tagName}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 lg:justify-end">
                      <Button variant="outline" size="sm" onClick={() => openEditDialog(recording)}>
                        <Edit className="h-4 w-4 mr-2" />
                        Edit
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => downloadRecording(recording)}>
                        <Download className="h-4 w-4 mr-2" />
                        Original
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => downloadRecording(recording, true)} disabled={exportingId === recording.id}>
                        {exportingId === recording.id ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                        MP3
                      </Button>
                      <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(recording)}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editingRecording} onOpenChange={(open) => !open && setEditingRecording(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Recording</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="edit-recording-title">Name</Label>
                <Input
                  id="edit-recording-title"
                  value={editForm.title}
                  onChange={(event) => setEditForm({ ...editForm, title: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-recording-tags">Tags</Label>
                <Input
                  id="edit-recording-tags"
                  value={editForm.tags}
                  onChange={(event) => setEditForm({ ...editForm, tags: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-recording-category">Category</Label>
                <Select
                  value={editForm.category}
                  onValueChange={(value) => setEditForm({ ...editForm, category: value as RecordingCategory })}
                >
                  <SelectTrigger id="edit-recording-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {recordingCategories.map((item) => (
                      <SelectItem key={item} value={item}>{recordingCategoryLabels[item]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-recording-recorded-at">Recorded</Label>
                <Input
                  id="edit-recording-recorded-at"
                  type="datetime-local"
                  value={editForm.recorded_at}
                  onChange={(event) => setEditForm({ ...editForm, recorded_at: event.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-recording-description">Description</Label>
              <Textarea
                id="edit-recording-description"
                value={editForm.description}
                onChange={(event) => setEditForm({ ...editForm, description: event.target.value })}
                rows={4}
              />
            </div>
            {editForm.category === 'music' && (
              <div className="space-y-2">
                <Label htmlFor="edit-recording-chords">Chords</Label>
                <Textarea
                  id="edit-recording-chords"
                  value={editForm.chords}
                  onChange={(event) => setEditForm({ ...editForm, chords: event.target.value })}
                  rows={5}
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditingRecording(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => editingRecording && updateRecording.mutate({
                  id: editingRecording.id,
                  payload: {
                    title: editForm.title,
                    description: editForm.description,
                    category: editForm.category,
                    recorded_at: datetimeLocalToIso(editForm.recorded_at),
                    metadata: editForm.category === 'music' ? { chords: editForm.chords } : {},
                    tags: parseTags(editForm.tags),
                  },
                })}
                disabled={updateRecording.isPending || !editForm.title.trim()}
              >
                {updateRecording.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!discardTarget} onOpenChange={(open) => !open && !discarding && setDiscardTarget(null)}>
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
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={discarding}
              onClick={(event) => {
                event.preventDefault();
                if (discardTarget) void discardRecording(discardTarget, discardUnconfirmed);
              }}
            >
              {discarding && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {discardUnconfirmed ? 'Discard anyway' : 'Discard'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete recording?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes {deleteTarget?.title || 'this recording'} and its stored audio file.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteRecording.mutate(deleteTarget.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Recordings;
