import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Music from '@/pages/Music';
import { api } from '@/lib/api';
import type { Recording } from '@/lib/recordings-api';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner', timezone: 'UTC' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const song = (id: string, title: string, chords: string | undefined): Recording => ({
  id, title, description: null, original_filename: null, content_type: 'audio/wav', size_bytes: 1000, duration_seconds: 90, source: 'recorded',
  category: 'music', recorded_at: '2026-10-10T08:00:00.000Z', metadata: chords === undefined ? {} : { chords }, tags: [], created_at: '2026-10-10T08:00:00.000Z', updated_at: '2026-10-10T08:00:00.000Z',
});
const songs = [song('song-a', 'Song A', 'C G Am F'), song('song-b', 'Song B', undefined)];

function mount(path = '/music') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Music /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/recordings')) return { data: { recordings: path.includes('music_missing_chords') ? songs.filter(item => !item.metadata.chords) : songs } };
    return { data: { modules: [] } };
  });
  vi.mocked(api.put).mockResolvedValue({ data: { recording: songs[1] } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Music', () => {
  it('shows every song with its chords, and plays one song at a time', async () => {
    const { container } = mount();
    expect(await screen.findByText('C G Am F')).toBeInTheDocument();
    expect(container.querySelectorAll('audio')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play Song A' }));
    expect(container.querySelector('audio')).toHaveAttribute('src', '/api/recordings/song-a/file');
    fireEvent.click(screen.getByRole('button', { name: 'Close the player for Song A' }));
    expect(container.querySelectorAll('audio')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Edit chords for Song A' }));
    expect(screen.getByLabelText('Chords for Song A')).toHaveValue('C G Am F');
  });

  it('offers the chords editor right away for a song without chords, and saves them', async () => {
    mount('/music?view=missing');
    const editor = await screen.findByLabelText('Chords for Song B');
    fireEvent.change(editor, { target: { value: 'Em  D' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save chords' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/recordings/song-b', { category: 'music', metadata: { chords: 'Em  D' } }));
    expect(state.toast).toHaveBeenCalledWith({ title: 'Chords saved' });
  });
});
