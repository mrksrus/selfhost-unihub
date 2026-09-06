import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecordingPlayer } from '@/components/recordings/RecordingPlayer';

describe('recording playback', () => {
  it('plays original audio without conversion and offers MP3 only after a playback failure', () => {
    const { container } = render(<RecordingPlayer id="my-recording" />);
    const audio = container.querySelector('audio')!;
    expect(audio.getAttribute('src')).toBe('/api/recordings/my-recording/file');
    expect(audio.getAttribute('preload')).toBe('none');
    expect(screen.queryByRole('button', { name: 'Try MP3 playback' })).not.toBeInTheDocument();
    fireEvent.error(audio);
    fireEvent.click(screen.getByRole('button', { name: 'Try MP3 playback' }));
    expect(audio.getAttribute('src')).toBe('/api/recordings/my-recording/file?format=mp3');
    fireEvent.error(audio);
    expect(screen.getByText(/You can still download the original/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try MP3 playback' })).not.toBeInTheDocument();
  });
});
