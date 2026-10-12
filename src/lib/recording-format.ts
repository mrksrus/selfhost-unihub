import type { StoredRecording } from '@/lib/recording-queue';
import type { Recording, RecordingCategory } from '@/lib/recordings-api';

export function formatBytes(value: number) {
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

export function formatDuration(value: number | null) {
  if (!value || value < 0) return 'Unknown length';
  const total = Math.round(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatRecordedAt(value: string | null | undefined) {
  if (!value) return 'No recording date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No recording date';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Comma-separated tags, trimmed, without case-insensitive duplicates, at most 20. */
export function parseTags(value: string) {
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

export function filenameWithoutExtension(filename: string) {
  return filename.replace(/\.[^.]+$/, '').trim() || 'Recording';
}

export function toDatetimeLocalValue(value: string | Date | null | undefined) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function datetimeLocalToIso(value: string) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function storedRecordingStatus(item: StoredRecording, bytesUploaded: number) {
  if (item.state === 'draft') return item.recovered ? 'Recovered, not saved yet' : 'Not saved yet';
  if (item.state === 'failed') return `Upload refused: ${item.error || 'unknown error'}`;
  const percent = item.size ? Math.round((bytesUploaded / item.size) * 100) : 0;
  return item.error ? `Waiting to upload (${percent}%): ${item.error}` : `Uploading (${percent}%)`;
}

/** The editable details of a recording, as form text. */
export interface RecordingDetailsForm {
  title: string;
  description: string;
  tags: string;
  category: RecordingCategory;
  recordedAt: string;
  chords: string;
}

export const emptyRecordingDetails = (): RecordingDetailsForm => ({
  title: '', description: '', tags: '', category: 'none', recordedAt: toDatetimeLocalValue(new Date()), chords: '',
});

export const recordingDetailsFrom = (recording: Recording): RecordingDetailsForm => ({
  title: recording.title,
  description: recording.description || '',
  tags: recording.tags.join(', '),
  category: recording.category || 'none',
  recordedAt: toDatetimeLocalValue(recording.recorded_at || recording.created_at),
  chords: recording.metadata?.chords || '',
});

/** The server fields of a details form. */
export const recordingDetailsPayload = (form: RecordingDetailsForm) => ({
  title: form.title.trim(),
  description: form.description.trim(),
  category: form.category,
  recorded_at: datetimeLocalToIso(form.recordedAt),
  metadata: form.category === 'music' ? { chords: form.chords } : {},
  tags: parseTags(form.tags),
});
