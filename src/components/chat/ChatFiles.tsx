import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Loader2, Pause, Play } from 'lucide-react';
import type { ChatEngine, ChatThreadFile } from '@/lib/chat/types';
import { formatBytes } from '@/lib/recording-format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AUDIO, isPdf, pictureType, useChatFile, useObjectUrl, useSaveFile } from '@/components/chat/chat-files';
import { clock } from '@/components/chat/chat-state';

interface FileProps { engine: ChatEngine; messageId: string; file: ChatThreadFile }

/** How far an own file is on its way; nothing once it is sent (a failed one is named by its message). */
function Upload({ file }: { file: ChatThreadFile }) {
  if (file.state !== 'uploading' && file.state !== 'waiting') return null;
  const percent = Math.round((file.progress ?? 0) * 100);
  return (
    <span role="progressbar" aria-label={`Sending ${file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="absolute inset-x-0 bottom-0 h-1 bg-foreground/15">
      <span className="block h-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
    </span>
  );
}

const sizeLine = (file: ChatThreadFile, progress: number | null) => (progress !== null ? `Getting it… ${Math.round(progress * 100)}%`
  : `${formatBytes(file.size)}${file.state === 'uploading' ? `, ${Math.round((file.progress ?? 0) * 100)}% sent` : file.state === 'waiting' ? ', waiting to be sent' : ''}`);

/** A picture at its proportions, so the thread does not jump when its preview arrives; a tap opens it. */
function Picture({ engine, messageId, file, onOpen }: FileProps & { onOpen: () => void }) {
  const [preview, setPreview] = useState<Blob | null>(null);
  useEffect(() => {
    let current = true;
    engine.picturePreview(messageId, file.id).then(blob => { if (current) setPreview(blob); }, () => undefined);
    return () => { current = false; setPreview(null); };
  }, [engine, messageId, file.id]);
  const src = useObjectUrl(preview, 'image/jpeg');
  const { width, height } = file.picture!;
  // At most 256 by 320 px, never larger than the picture, and a very long or wide one keeps a side one can tap.
  const scale = Math.min(256 / Math.max(width, 1), 320 / Math.max(height, 1), 1);
  const box = { width: Math.max(48, Math.round(width * scale)), height: Math.max(48, Math.round(height * scale)) };
  return (
    <button type="button" onClick={onOpen} aria-label={`Open the picture ${file.name}`} style={{ width: box.width, aspectRatio: `${box.width} / ${box.height}` }}
      className="relative block max-w-full overflow-hidden rounded-lg bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {src && <img src={src} alt="" className="h-full w-full object-cover" />}
      <Upload file={file} />
    </button>
  );
}

/**
 * A voice message: its length, and a tap fetches and plays it. A recording
 * this browser cannot play (another browser's format) is offered to save.
 */
function Voice({ engine, messageId, file }: FileProps) {
  const { blob, progress, failed, fetch } = useChatFile(engine, messageId, file.id);
  const save = useSaveFile();
  const type = AUDIO.exec(file.type)?.[0] ?? null;
  const [unplayable, setUnplayable] = useState(() => !type || !document.createElement('audio').canPlayType(file.type));
  const src = useObjectUrl(unplayable ? null : blob, type ?? '');
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const length = file.voice_seconds ?? 0;
  const toggle = () => {
    if (!blob) void fetch();
    else if (audio.current?.paused) void audio.current.play().catch(() => setUnplayable(true));
    else audio.current?.pause();
  };
  return (
    <div className="relative flex w-64 max-w-full items-center gap-2.5 overflow-hidden rounded-lg bg-background/60 py-1.5 pl-1.5 pr-3">
      {unplayable ? (
        <Button type="button" variant="outline" size="icon" className="shrink-0 rounded-full" disabled={progress !== null} aria-label={`Save the voice message, ${clock(length)}`}
          onClick={() => { if (blob) save(blob, file.name); else void fetch(false).then(got => { if (got) save(got, file.name); }); }}>
          {progress !== null ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : <Download aria-hidden="true" />}
        </Button>
      ) : (
        <Button type="button" size="icon" className="shrink-0 rounded-full" disabled={progress !== null} aria-label={playing ? 'Pause the voice message' : `Play the voice message, ${clock(length)}`} onClick={toggle}>
          {progress !== null ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : playing ? <Pause aria-hidden="true" fill="currentColor" /> : <Play aria-hidden="true" fill="currentColor" />}
        </Button>
      )}
      <div className="min-w-0 flex-1">
        {unplayable ? <p className="text-xs">This browser cannot play this recording. Save it to listen in another app.</p>
          : <input type="range" aria-label="Position in the voice message" min={0} max={length || 1} step={0.1} value={Math.min(at, length || 1)} disabled={!src}
            onChange={event => { const next = Number(event.target.value); setAt(next); if (audio.current) audio.current.currentTime = next; }}
            className="block h-4 w-full accent-accent disabled:opacity-60 touch:h-6" />}
        <p className={cn('text-[11px] tabular-nums', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {failed ?? (file.state !== 'sent' ? sizeLine(file, null) : playing || at > 0 ? `${clock(at)} of ${clock(length)}` : `Voice message, ${clock(length)}`)}
        </p>
      </div>
      {src && <audio ref={audio} src={src} autoPlay className="hidden" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setAt(0); }}
        onTimeUpdate={event => setAt(event.currentTarget.currentTime)} onError={() => setUnplayable(true)} />}
      <Upload file={file} />
    </div>
  );
}

/** Any other file: its name and size, and Save. A PDF also opens in the reader. */
function FileRow({ engine, messageId, file, onOpen }: FileProps & { onOpen?: () => void }) {
  const { progress, failed, fetch } = useChatFile(engine, messageId, file.id);
  const save = useSaveFile();
  const words = (
    <span className="min-w-0 flex-1 text-left">
      <span className="block truncate font-medium">{file.name}</span>
      <span className={cn('block truncate text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}>{failed ?? sizeLine(file, progress)}</span>
    </span>
  );
  const icon = <FileText aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />;
  return (
    <div className="relative flex w-72 max-w-full items-center gap-1 overflow-hidden rounded-lg bg-background/60 py-1 pl-2.5 pr-1">
      {onOpen ? <button type="button" onClick={onOpen} aria-label={`Open ${file.name}`} className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{icon}{words}</button>
        : <span className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5">{icon}{words}</span>}
      <Button type="button" variant="ghost" size="icon" className="shrink-0" disabled={progress !== null} aria-label={`Save ${file.name}`} onClick={() => void fetch(false).then(got => { if (got) save(got, file.name); })}>
        {progress !== null ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : <Download aria-hidden="true" />}
      </Button>
      <Upload file={file} />
    </div>
  );
}

/** The files of a message, in its bubble: pictures by their preview, voice messages with a player, the rest as rows. Nothing but a preview is fetched before a tap. */
export function MessageFiles({ engine, messageId, files, onOpen }: { engine: ChatEngine; messageId: string; files: ChatThreadFile[]; onOpen: (file: ChatThreadFile) => void }) {
  return (
    <ul aria-label="Files" className="mb-1 space-y-1.5">
      {files.map(file => (
        <li key={file.id}>
          {file.voice_seconds !== null ? <Voice engine={engine} messageId={messageId} file={file} />
            : file.picture && pictureType(file) ? <Picture engine={engine} messageId={messageId} file={file} onOpen={() => onOpen(file)} />
            : <FileRow engine={engine} messageId={messageId} file={file} onOpen={isPdf(file) ? () => onOpen(file) : undefined} />}
        </li>
      ))}
    </ul>
  );
}
