import { api, type ApiResponse } from '@/lib/api';
export type Note = { id: string; title: string; body: string; revision: number; trashed_at: string | null; created_at: string; updated_at: string };
export type NoteDetail = { note: Note; revisions: { revision: number; title: string; created_at: string }[]; attachments: { id: string; filename: string; content_type: string; size_bytes: number; created_at: string }[]; links: { id: string; title: string }[] };
export async function noteResponse<T>(request: Promise<ApiResponse<T>>) {
  const response = await request;
  if (response.error || !response.data) throw Object.assign(new Error(response.error || 'No note data returned.'), { status: response.status });
  return response.data;
}
export const notePath = (id: string) => `/notes/${encodeURIComponent(id)}`;
export async function downloadNoteFile(path: string, fallback: string) {
  const { blob, filename } = await api.getBlob(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename || fallback; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
