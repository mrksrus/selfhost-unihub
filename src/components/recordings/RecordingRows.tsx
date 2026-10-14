import { Download, Loader2, MoreHorizontal } from 'lucide-react';
import { recordingCategoryLabels, type Recording } from '@/lib/recordings-api';
import type { StoredRecording } from '@/lib/recording-queue';
import { formatBytes, formatDuration, formatRecordedAt, storedRecordingStatus } from '@/lib/recording-format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PlayButton, RecordingPlayer } from '@/components/recordings/RecordingPlayer';

interface RowProps {
  recording: Recording;
  playing: boolean;
  exporting: boolean;
  activeTag: string;
  onPlay: () => void;
  onEdit: () => void;
  onDownload: (mp3: boolean) => void;
  onDelete: () => void;
  onTag: (tag: string) => void;
}

/** A recording in the library with its details in view; the player appears for the one being played. */
export function RecordingRow({ recording, playing, exporting, activeTag, onPlay, onEdit, onDownload, onDelete, onTag }: RowProps) {
  const meta = [formatRecordedAt(recording.recorded_at), formatDuration(recording.duration_seconds),
    recording.category !== 'none' ? recordingCategoryLabels[recording.category] : null,
    formatBytes(recording.size_bytes), recording.source === 'recorded' ? 'recorded here' : 'imported'].filter(Boolean);
  const details = recording.description || (recording.category === 'music' && recording.metadata?.chords) || recording.tags.length > 0;
  return (
    <li className="grid grid-cols-[auto_1fr_auto] gap-x-3 border-b border-border py-3">
      <PlayButton title={recording.title} playing={playing} onToggle={onPlay} />
      <div className="min-w-0">
        <p className="break-words font-medium">{recording.title}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {meta.map(item => <span key={item}>{item}</span>)}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="-my-1 -mr-1 text-muted-foreground" disabled={exporting} aria-label={`More actions for ${recording.title}`}>
            {exporting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <MoreHorizontal aria-hidden="true" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onDownload(false)}>Download</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onDownload(true)}>Download as MP3</DropdownMenuItem>
          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {(playing || details) && (
        <div className="col-start-2 mt-2 space-y-2.5">
          {playing && <RecordingPlayer id={recording.id} autoPlay />}
          {recording.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{recording.description}</p>}
          {recording.category === 'music' && recording.metadata?.chords && (
            <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-sm">{recording.metadata.chords}</pre>
          )}
          {recording.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {recording.tags.map(tag => (
                <button key={tag} type="button" onClick={() => onTag(tag)} aria-pressed={activeTag === tag}
                  className={cn('rounded-full px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    activeTag === tag ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground hover:text-foreground')}>
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

interface DeviceRowProps {
  item: StoredRecording;
  bytesUploaded: number;
  canContinue: boolean;
  canDiscard: boolean;
  onContinue: () => void;
  onRetry: () => void;
  onDownload: () => void;
  onDiscard: () => void;
}

/** A recording kept on this device: a draft to save, or an upload in progress. */
export function DeviceRecordingRow({ item, bytesUploaded, canContinue, canDiscard, onContinue, onRetry, onDownload, onDiscard }: DeviceRowProps) {
  const status = storedRecordingStatus(item, bytesUploaded);
  return (
    <li className="border-b border-border py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.details.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {formatRecordedAt(item.details.recorded_at || new Date(item.createdAt).toISOString())} · {formatDuration(item.details.duration_seconds)} · {formatBytes(item.size)}
          </p>
          <p className={cn('text-xs', item.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{status}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {item.state === 'draft' && <Button size="sm" onClick={onContinue} disabled={!canContinue}>Continue</Button>}
          {item.state === 'failed' && <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
          {item.state === 'queued' && item.error && <Button size="sm" variant="outline" onClick={onRetry}>Retry now</Button>}
          <Button size="icon-sm" variant="ghost" aria-label={`Download ${item.details.title}`} onClick={onDownload}><Download aria-hidden="true" /></Button>
          {canDiscard && <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDiscard}>Discard</Button>}
        </div>
      </div>
      {item.state === 'queued' && <Progress className="mt-2 h-1" value={item.size ? (bytesUploaded / item.size) * 100 : 0} />}
    </li>
  );
}
