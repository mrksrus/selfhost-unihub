import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import lamejs from 'lamejs';
import { api } from '@/lib/api';
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
import {
  Download,
  Edit,
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
};

const CHUNK_SIZE = 512 * 1024;
const EMPTY_RECORDINGS: Recording[] = [];

function getSupportedRecordingMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || '';
}

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

function uint8ToBase64(bytes: Uint8Array) {
  let binary = '';
  const stride = 0x8000;
  for (let index = 0; index < bytes.length; index += stride) {
    const chunk = bytes.subarray(index, index + stride);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
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

function floatTo16BitPcm(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

async function encodeBlobToMp3(blob: Blob) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser cannot encode audio.');
  const audioContext = new AudioContextClass();
  try {
    const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const channels = Math.min(2, buffer.numberOfChannels || 1);
    const encoder = new lamejs.Mp3Encoder(channels, buffer.sampleRate, 128);
    const left = floatTo16BitPcm(buffer.getChannelData(0));
    const right = channels > 1 ? floatTo16BitPcm(buffer.getChannelData(1)) : undefined;
    const mp3Chunks: Int8Array[] = [];

    for (let offset = 0; offset < left.length; offset += 1152) {
      const leftChunk = left.subarray(offset, offset + 1152);
      const rightChunk = right?.subarray(offset, offset + 1152);
      const encoded = channels > 1 ? encoder.encodeBuffer(leftChunk, rightChunk) : encoder.encodeBuffer(leftChunk);
      if (encoded.length > 0) mp3Chunks.push(encoded);
    }

    const finalChunk = encoder.flush();
    if (finalChunk.length > 0) mp3Chunks.push(finalChunk);
    return new Blob(mp3Chunks, { type: 'audio/mpeg' });
  } finally {
    await audioContext.close().catch(() => {});
  }
}

const Recordings = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
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
    }, 250);
    return () => window.clearInterval(timer);
  }, [recordingState]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
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

  const uploadAudio = useMutation({
    mutationFn: async (audio: PendingAudio) => {
      setUploadProgress(0);
      const bytes = new Uint8Array(await audio.blob.arrayBuffer());
      const start = await recordingsApi.startUpload({
        title: title.trim() || filenameWithoutExtension(audio.filename),
        description: description.trim(),
        original_filename: audio.filename,
        content_type: audio.contentType || audio.blob.type || 'audio/webm',
        total_bytes: bytes.byteLength,
        duration_seconds: audio.durationSeconds,
        source: audio.source,
        category,
        recorded_at: datetimeLocalToIso(recordedAt),
        metadata: category === 'music' ? { chords: musicChords } : {},
        tags: parseTags(tagInput),
      });

      const uploadId = start.id;
      const chunkSize = Math.min(start.max_chunk_bytes || CHUNK_SIZE, CHUNK_SIZE);
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        await recordingsApi.uploadChunk(uploadId, {
          offset,
          data_base64: uint8ToBase64(chunk),
        });
        setUploadProgress(Math.round(((offset + chunk.byteLength) / bytes.byteLength) * 100));
      }

      return recordingsApi.completeUpload(uploadId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recordingsQueryKeys.all });
      setPendingAudio(null);
      setTitle('');
      setDescription('');
      setTagInput('');
      setCategory('none');
      setRecordedAt(toDatetimeLocalValue(new Date()));
      setMusicChords('');
      setUploadProgress(null);
      toast({ title: 'Recording saved' });
    },
    onError: (error: Error) => {
      setUploadProgress(null);
      toast({ title: 'Recording upload failed', description: error.message, variant: 'destructive' });
    },
  });

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

  const stopRecordingTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast({ title: 'Recording is not available in this browser', variant: 'destructive' });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      startedAtRef.current = Date.now();
      pausedAtRef.current = null;
      pausedMsRef.current = 0;
      setElapsedSeconds(0);
      setPendingAudio(null);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const contentType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: contentType });
        const durationSeconds = elapsedSeconds || (
          startedAtRef.current ? Math.max(0, (Date.now() - startedAtRef.current - pausedMsRef.current) / 1000) : null
        );
        setPendingAudio({
          blob,
          filename: `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`,
          contentType,
          source: 'recorded',
          durationSeconds,
        });
        const stoppedAt = new Date();
        setTitle((current) => current || `Recording ${stoppedAt.toLocaleString()}`);
        setRecordedAt(toDatetimeLocalValue(stoppedAt));
        setRecordingState('idle');
        mediaRecorderRef.current = null;
        stopRecordingTracks();
      };

      recorder.start();
      setRecordingState('recording');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Microphone access failed';
      toast({ title: 'Could not start recording', description: message, variant: 'destructive' });
      stopRecordingTracks();
    }
  };

  const pauseRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.pause();
    pausedAtRef.current = Date.now();
    setRecordingState('paused');
  };

  const resumeRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'paused') return;
    if (pausedAtRef.current) pausedMsRef.current += Date.now() - pausedAtRef.current;
    pausedAtRef.current = null;
    recorder.resume();
    setRecordingState('recording');
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
  };

  const handleImportFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|wav|ogg|webm)$/i.test(file.name)) {
      toast({ title: 'Please choose an audio file', variant: 'destructive' });
      return;
    }
    setPendingAudio({
      blob: file,
      filename: file.name,
      contentType: file.type || 'audio/mpeg',
      source: 'imported',
      durationSeconds: null,
    });
    setTitle(filenameWithoutExtension(file.name));
    setRecordedAt(toDatetimeLocalValue(new Date()));
  };

  const downloadRecording = async (recording: Recording, exportMp3 = false) => {
    try {
      setExportingId(recording.id);
      const { blob, filename } = await api.getBlob(`/recordings/${recording.id}/file?download=1`);
      if (!exportMp3 || recording.content_type.includes('mpeg') || /\.mp3$/i.test(filename || recording.original_filename || '')) {
        saveBlob(blob, filename || recording.original_filename || `${recording.title}.audio`);
        return;
      }
      const mp3Blob = await encodeBlobToMp3(blob);
      saveBlob(mp3Blob, `${recording.title.replace(/[/\\]/g, '_') || 'recording'}.mp3`);
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
                <CardDescription>Browser microphone recording with local preview before upload</CardDescription>
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
              <span className="font-mono text-sm text-muted-foreground">{formatDuration(elapsedSeconds)}</span>
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
                  <Button variant="outline" onClick={() => setPendingAudio(null)} disabled={uploadAudio.isPending}>
                    Discard
                  </Button>
                  <Button onClick={() => uploadAudio.mutate(pendingAudio)} disabled={uploadAudio.isPending || !title.trim()}>
                    {uploadAudio.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
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
                <CardDescription>MP3, M4A, WAV, OGG, or WebM</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm"
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
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : recordingsQuery.error ? (
            <p className="text-sm text-destructive">Could not load recordings.</p>
          ) : recordings.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              <FileAudio className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p>No recordings yet.</p>
            </div>
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
                      <audio controls className="w-full max-w-2xl" src={`/api/recordings/${recording.id}/file`} />
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
