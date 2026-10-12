import { ChevronDown, Download, FileAudio, Loader2 } from 'lucide-react';
import { recordingCategoryLabels, type Recording } from '@/lib/recordings-api';
import type { StoredRecording } from '@/lib/recording-queue';
import { formatBytes, formatDuration, formatRecordedAt, storedRecordingStatus } from '@/lib/recording-format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RecordingPlayer } from '@/components/recordings/RecordingPlayer';

interface RowProps {
  recording: Recording;
  open: boolean;
  exporting: boolean;
  activeTag: string;
  onToggle: () => void;
  onEdit: () => void;
  onDownload: (mp3: boolean) => void;
  onDelete: () => void;
  onTag: (tag: string) => void;
}

/** A recording in the library. Opening it shows the player and what can be done with it. */
export function RecordingRow({ recording, open, exporting, activeTag, onToggle, onEdit, onDownload, onDelete, onTag }: RowProps) {
  const meta = [formatRecordedAt(recording.recorded_at), formatDuration(recording.duration_seconds),
    recording.category !== 'none' ? recordingCategoryLabels[recording.category] : null].filter(Boolean).join(' · ');
  return (
    <li className="border-b border-border">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center gap-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <FileAudio aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{recording.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{meta}</span>
        </span>
        <ChevronDown aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-3 pb-4 pl-7">
          <RecordingPlayer id={recording.id} />
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
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onEdit}>Edit</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={exporting}>
                  {exporting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Download aria-hidden="true" />}Download
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => onDownload(false)}>Original file</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDownload(true)}>As MP3</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="text-xs text-muted-foreground">{formatBytes(recording.size_bytes)}, {recording.source === 'recorded' ? 'recorded here' : 'imported'}</span>
            <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={onDelete}>Delete</Button>
          </div>
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
          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Download ${item.details.title}`} onClick={onDownload}><Download aria-hidden="true" /></Button>
          {canDiscard && <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDiscard}>Discard</Button>}
        </div>
      </div>
      {item.state === 'queued' && <Progress className="mt-2 h-1" value={item.size ? (bytesUploaded / item.size) * 100 : 0} />}
    </li>
  );
}
