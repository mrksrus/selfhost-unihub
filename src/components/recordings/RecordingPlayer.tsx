import { useState } from 'react';
import { Play, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function RecordingPlayer({ id, autoPlay = false }: { id: string; autoPlay?: boolean }) {
  const [useMp3, setUseMp3] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  return (
    <div className="space-y-2">
      <audio
        controls
        autoPlay={autoPlay || useMp3}
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

/**
 * The round control at the start of a song or recording row. Only the row
 * whose control is pressed mounts a player, so a long list stays one list and
 * not dozens of audio elements.
 */
export function PlayButton({ title, playing, onToggle }: { title: string; playing: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={playing} aria-label={playing ? `Close the player for ${title}` : `Play ${title}`}
      className={cn('tap-area mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] touch:h-6 touch:w-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        playing ? 'border-accent bg-accent text-accent-foreground' : 'border-muted-foreground/60 text-muted-foreground hover:border-accent hover:text-accent')}>
      {playing
        ? <Square aria-hidden="true" className="h-2 w-2 touch:h-2.5 touch:w-2.5" fill="currentColor" strokeWidth={0} />
        : <Play aria-hidden="true" className="ml-px h-2.5 w-2.5 touch:h-3 touch:w-3" fill="currentColor" strokeWidth={0} />}
    </button>
  );
}
