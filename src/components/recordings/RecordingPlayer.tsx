import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function RecordingPlayer({ id }: { id: string }) {
  const [useMp3, setUseMp3] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  return (
    <div className="space-y-2">
      <audio
        controls
        autoPlay={useMp3}
        preload="none"
        className="w-full max-w-2xl"
        src={`/api/recordings/${encodeURIComponent(id)}/file${useMp3 ? '?format=mp3' : ''}`}
        onError={() => setPlaybackFailed(true)}
        onCanPlay={() => setPlaybackFailed(false)}
      />
      {playbackFailed && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{useMp3 ? 'MP3 playback is unavailable. You can still download the original.' : 'This browser could not play the original audio.'}</span>
          {!useMp3 && (
            <Button size="sm" variant="outline" onClick={() => {
              setPlaybackFailed(false);
              setUseMp3(true);
            }}>
              Try MP3 playback
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
