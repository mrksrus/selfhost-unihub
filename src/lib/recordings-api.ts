import { api } from '@/lib/api';

export const recordingCategories = ['none', 'music', 'journal', 'memory', 'reminder'] as const;

export type RecordingCategory = typeof recordingCategories[number];

export const recordingCategoryLabels: Record<RecordingCategory, string> = {
  none: 'None',
  music: 'Music',
  journal: 'Journal',
  memory: 'Memory',
  reminder: 'Reminder',
};

export interface RecordingMetadata {
  chords?: string;
}

export interface Recording {
  id: string;
  title: string;
  description: string | null;
  original_filename: string | null;
  content_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  source: 'recorded' | 'imported';
  category: RecordingCategory;
  recorded_at: string;
  metadata: RecordingMetadata;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface RecordingListFilters {
  search?: string;
  tag?: string;
  category?: RecordingCategory;
  musicMissingChords?: boolean;
}

export interface RecordingUploadStartPayload {
  title: string;
  description?: string;
  original_filename: string;
  content_type: string;
  total_bytes: number;
  duration_seconds: number | null;
  source: 'recorded' | 'imported';
  category?: RecordingCategory;
  recorded_at?: string;
  metadata?: RecordingMetadata;
  tags?: string[];
}

export interface RecordingUpload {
  id: string;
  bytes_received: number;
  total_bytes: number;
  max_chunk_bytes: number;
  expires_at: string;
}

export interface RecordingUpdatePayload {
  title?: string;
  description?: string;
  category?: RecordingCategory;
  recorded_at?: string;
  metadata?: RecordingMetadata;
  tags?: string[];
}

function buildRecordingsQuery(filters: RecordingListFilters = {}) {
  const params = new URLSearchParams();
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.tag?.trim()) params.set('tag', filters.tag.trim());
  if (filters.category) params.set('category', filters.category);
  if (filters.musicMissingChords) params.set('music_missing_chords', 'true');
  const query = params.toString();
  return query ? `/recordings?${query}` : '/recordings';
}

function stableRecordingFilterKey(filters: RecordingListFilters = {}) {
  return [
    `search=${filters.search?.trim() || ''}`,
    `tag=${filters.tag?.trim() || ''}`,
    `category=${filters.category || ''}`,
    `musicMissingChords=${filters.musicMissingChords ? '1' : '0'}`,
  ].join(';');
}

export const recordingsQueryKeys = {
  all: ['recordings'] as const,
  list: (filters: RecordingListFilters = {}) => ['recordings', stableRecordingFilterKey(filters)] as const,
};

export const recordingsApi = {
  async list(filters: RecordingListFilters = {}): Promise<Recording[]> {
    const response = await api.get<{ recordings: Recording[] }>(buildRecordingsQuery(filters));
    if (response.error) throw new Error(response.error);
    return response.data?.recordings || [];
  },

  async startUpload(payload: RecordingUploadStartPayload): Promise<RecordingUpload> {
    const response = await api.post<{ upload: RecordingUpload }>('/recordings/uploads/start', payload);
    if (response.error || !response.data?.upload) throw new Error(response.error || 'Could not start upload');
    return response.data.upload;
  },

  async uploadChunk(uploadId: string, payload: { offset: number; data_base64: string }): Promise<RecordingUpload> {
    const response = await api.post<{ upload: RecordingUpload }>(`/recordings/uploads/${uploadId}/chunk`, payload);
    if (response.error || !response.data?.upload) throw new Error(response.error || 'Could not upload chunk');
    return response.data.upload;
  },

  async completeUpload(uploadId: string): Promise<Recording> {
    const response = await api.post<{ recording: Recording }>(`/recordings/uploads/${uploadId}/complete`);
    if (response.error || !response.data?.recording) throw new Error(response.error || 'Could not complete upload');
    return response.data.recording;
  },

  async update(id: string, payload: RecordingUpdatePayload): Promise<Recording> {
    const response = await api.put<{ recording: Recording }>(`/recordings/${id}`, payload);
    if (response.error || !response.data?.recording) throw new Error(response.error || 'Could not update recording');
    return response.data.recording;
  },

  async delete(id: string): Promise<void> {
    const response = await api.delete(`/recordings/${id}`);
    if (response.error) throw new Error(response.error);
  },
};
