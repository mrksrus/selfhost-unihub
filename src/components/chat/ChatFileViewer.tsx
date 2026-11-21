import { useEffect, useState } from 'react';
import { Download, Minus, Plus, X } from 'lucide-react';
import type { ChatEngine, ChatThreadFile } from '@/lib/chat/types';
import { formatBytes } from '@/lib/recording-format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, LoadingState } from '@/components/ui/page-states';
import { ImagePreview, PdfPreview } from '@/components/mail/AttachmentViewer';
import { pictureType, useChatFile, useObjectUrl, useSaveFile } from '@/components/chat/chat-files';
import { HandOverButtons } from '@/components/chat/ChatFiles';

interface Props {
  engine: ChatEngine;
  /** The picture or PDF to show; null while the viewer is closed. */
  open: { messageId: string; file: ChatThreadFile } | null;
  onClose: () => void;
}

/**
 * A chat's picture or PDF over the page. The file is fetched and decrypted
 * when the viewer opens and is gone from the page when it closes. A picture
 * is drawn by <img>, a PDF by the reader mail uses (pdf.js on a canvas).
 */
export function ChatFileViewer({ engine, open, onClose }: Props) {
  return (
    <Dialog open={!!open} onOpenChange={next => { if (!next) onClose(); }}>
      {open && <Content key={open.file.id} engine={engine} {...open} />}
    </Dialog>
  );
}

function Content({ engine, messageId, file }: { engine: ChatEngine; messageId: string; file: ChatThreadFile }) {
  const { blob, progress, failed, fetch } = useChatFile(engine, messageId, file.id);
  useEffect(() => { void fetch(); }, [fetch]);
  const save = useSaveFile();
  const picture = pictureType(file);
  const src = useObjectUrl(picture ? blob : null, picture ?? '');
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const [pages, setPages] = useState<{ current: number; total: number } | null>(null);
  const scale = zoom ?? fit;
  const zoomBy = (step: number) => setZoom(Math.min(3, Math.max(0.5, Math.round((scale + step) * 4) / 4)));
  const saveButton = <Button type="button" disabled={!blob} onClick={() => blob && save(blob, file.name)}><Download aria-hidden="true" />Save</Button>;
  const size = formatBytes(file.size);

  return (
    <DialogContent className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden border-0 p-0 sm:h-[90dvh] sm:w-[calc(100vw-2rem)] sm:max-w-5xl sm:rounded-lg sm:border [&>button:last-child]:hidden">
      <header className="flex items-center gap-1 border-b border-border bg-background px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-3 sm:pt-2">
        <div className="min-w-0 flex-1 pl-1">
          <DialogTitle className="truncate text-sm font-medium leading-5">{file.name}</DialogTitle>
          <DialogDescription className="truncate text-xs text-muted-foreground">{size}{pages && `, page ${pages.current} of ${pages.total}`}</DialogDescription>
        </div>
        {pages && <>
          <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" disabled={scale <= 0.5} onClick={() => zoomBy(-0.25)}><Minus aria-hidden="true" /></Button>
          <Button type="button" variant="ghost" className="hidden w-14 px-0 tabular-nums sm:inline-flex" aria-label={`Fit to width (now ${Math.round(scale * 100)}%)`} onClick={() => setZoom(null)}>{Math.round(scale * 100)}%</Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Zoom in" disabled={scale >= 3} onClick={() => zoomBy(0.25)}><Plus aria-hidden="true" /></Button>
        </>}
        <HandOverButtons name={file.name} disabled={!blob} onPick={target => blob && save(blob, file.name, target)} />
        <Button type="button" variant="ghost" size="icon" aria-label="Save" disabled={!blob} onClick={() => blob && save(blob, file.name)}><Download aria-hidden="true" /></Button>
        <DialogClose asChild><Button type="button" variant="ghost" size="icon" aria-label="Close"><X aria-hidden="true" /></Button></DialogClose>
      </header>
      <div className="relative min-h-0 flex-1 bg-muted pb-[env(safe-area-inset-bottom)]">
        {failed ? <EmptyState title="Could not open this file" description={failed} className="h-full px-4" action={<Button type="button" variant="outline" onClick={() => void fetch()}>Try again</Button>} />
          : !blob || (picture && !src) ? <LoadingState label={progress ? `Getting the file… ${Math.round(progress * 100)}%` : 'Getting the file…'} className="h-full" />
          : src ? <ImagePreview src={src} alt={file.name} fileLine={`${file.name}, ${size}`} download={saveButton} />
          : <PdfPreview blob={blob} zoom={zoom} onFitScale={setFit} onPages={setPages} download={saveButton} />}
      </div>
    </DialogContent>
  );
}
