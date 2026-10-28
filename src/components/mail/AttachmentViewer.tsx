import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { PDFDocumentProxy, RenderTask, TextLayer as PdfTextLayer } from 'pdfjs-dist';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileQuestion, Minus, Plus, Share2, SquareArrowOutUpRight, X } from 'lucide-react';
import { api } from '@/lib/api';
import { loadPdfJs, pdfDocumentOptions, pdfFailureDetail, type PdfJs } from '@/lib/pdf';
import { appFileActions, saveFile, type AppFileAction } from '@/lib/platform';
import { createFileTicket } from '@/lib/file-tickets-api';
import { emailSrcDoc, prepareEmailHtml } from '@/lib/email-privacy';
import type { EmailAttachment } from '@/lib/mail-api';
import { useAttachmentDownload } from '@/hooks/use-attachment-download';
import { useToast } from '@/hooks/use-toast';
import { formatAttachmentSize } from '@/components/mail/mail-page-model';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, LoadingState } from '@/components/ui/page-states';
import './pdf-text-layer.css';

type PreviewKind = 'image' | 'pdf' | 'text' | 'html' | 'audio' | 'video' | 'none';

const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
// Formats every current browser draws in an <img>; others (TIFF, HEIC) fail and say so.
const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain', text: 'text/plain', csv: 'text/csv', tsv: 'text/plain', md: 'text/plain', markdown: 'text/plain', log: 'text/plain',
  ics: 'text/calendar', vcf: 'text/plain', json: 'application/json', xml: 'text/plain', yaml: 'text/plain', yml: 'text/plain',
  html: 'text/html', htm: 'text/html',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
};

function kindOfType(type: string): PreviewKind {
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf' || type === 'application/x-pdf') return 'pdf';
  if (type === 'text/html') return 'html';
  if (type.startsWith('text/') || type === 'application/json' || type.endsWith('+json') || type === 'application/xml') return 'text';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return 'none';
}

/**
 * How an attachment is previewed, and the type its bytes are shown as. Senders
 * often label files generically (application/octet-stream) or oddly (a CSV as
 * an Excel file), so the file extension decides when the type does not.
 */
function previewOf(attachment: Pick<EmailAttachment, 'filename' | 'content_type'>): { kind: PreviewKind; type: string } {
  const declared = (attachment.content_type || '').split(';')[0].trim().toLowerCase();
  const declaredKind = kindOfType(declared);
  if (declaredKind !== 'none') return { kind: declaredKind, type: declared };
  const extension = (attachment.filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const type = EXTENSION_TYPES[extension];
  return type ? { kind: kindOfType(type), type } : { kind: 'none', type: declared };
}

/**
 * The object-URL type for an attachment. Text is always plain text, HTML gets
 * no URL and SVG is only drawn inside <img>: "Open in new tab" shows the URL as
 * a page of this app's origin, where a sender's HTML or SVG could run scripts.
 */
function displayType(kind: PreviewKind, type: string) {
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'text') return 'text/plain;charset=utf-8';
  return type;
}

const SVG_TYPE = 'image/svg+xml';

/**
 * A blob: URL belongs to this app's origin, and the browser's own "Open image
 * in new tab" would run an SVG's scripts there. SVG therefore gets a data: URL,
 * which is drawn identically in <img> but opens with an opaque origin.
 */
function dataUrl(blob: Blob, type: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the attachment'));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the attachment'));
    signal.addEventListener('abort', () => reader.abort(), { once: true });
    reader.readAsDataURL(new Blob([blob], { type }));
  });
}

function canOpenInTab(kind: PreviewKind, type: string) {
  return kind === 'pdf' || kind === 'text' || (kind === 'image' && RASTER_IMAGE_TYPES.has(type));
}

function loadErrorMessage(error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401) return 'Session expired. Please sign in again and retry.';
  if (status === 404) return 'Attachment not found (it may not be available on disk).';
  if (status && status >= 500) return 'Server error while loading the attachment.';
  return 'Check your connection and try again.';
}

interface Props {
  /** The message's attachments; previous and next move through them. */
  attachments: EmailAttachment[];
  /** The attachment to show, or null when the viewer is closed. */
  openId: string | null;
  onClose: () => void;
}

/**
 * Shows a message's attachments over the page: images, PDFs (drawn with pdf.js,
 * so phones without a built-in PDF viewer work too), text, HTML without
 * scripts, audio and video. Other files offer Download.
 */
export function AttachmentViewer({ attachments, openId, onClose }: Props) {
  return (
    <Dialog open={openId !== null} onOpenChange={open => { if (!open) onClose(); }}>
      {openId !== null && <ViewerContent key={openId} attachments={attachments} initialId={openId} />}
    </Dialog>
  );
}

type Loaded = { id: string; blob: Blob; filename: string } | { id: string; error: unknown };

function ViewerContent({ attachments, initialId }: { attachments: EmailAttachment[]; initialId: string }) {
  const [currentId, setCurrentId] = useState(initialId);
  const index = Math.max(0, attachments.findIndex(attachment => attachment.id === currentId));
  const attachment = attachments[index] as EmailAttachment | undefined;
  const { kind, type } = useMemo(() => attachment ? previewOf(attachment) : { kind: 'none' as PreviewKind, type: '' }, [attachment]);
  // Fetched files stay here while the viewer is open, so previous/next does not fetch again.
  const cache = useRef(new Map<string, { blob: Blob; filename: string }>());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<{ id: string; href: string } | null>(null);
  const [pdfZoom, setPdfZoom] = useState<number | null>(null);
  const [pdfFit, setPdfFit] = useState(1);
  const [pdfPages, setPdfPages] = useState<{ current: number; total: number } | null>(null);
  const fallbackDownload = useAttachmentDownload();
  const { toast } = useToast();
  // In the Android app the file goes to Android's own sheets through a download ticket.
  const [appFiles] = useState(appFileActions);
  const [running, setRunning] = useState<AppFileAction | null>(null);
  const id = attachment?.id;

  useEffect(() => {
    if (!id) return;
    const cached = cache.current.get(id);
    if (cached) { setLoaded({ id, ...cached }); return; }
    const controller = new AbortController();
    api.getBlob(`/mail/attachments/${id}`, { signal: controller.signal }).then(({ blob, filename = '' }) => {
      cache.current.set(id, { blob, filename });
      if (!controller.signal.aborted) setLoaded({ id, blob, filename });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setLoaded({ id, error });
    });
    return () => controller.abort();
  }, [id, attempt]);

  // A late answer for an attachment the viewer has moved away from is never shown.
  const current = loaded?.id === id ? loaded : null;
  const blob = current && 'blob' in current ? current.blob : null;

  useEffect(() => {
    if (!blob || !id || kind === 'html' || kind === 'none') return;
    if (type === SVG_TYPE) {
      const controller = new AbortController();
      dataUrl(blob, SVG_TYPE, controller.signal).then(href => {
        if (!controller.signal.aborted) setUrl({ id, href });
      }, () => { /* the viewer keeps showing its loading state; Download still works */ });
      return () => controller.abort();
    }
    const href = URL.createObjectURL(new Blob([blob], { type: displayType(kind, type) }));
    setUrl({ id, href });
    return () => URL.revokeObjectURL(href);
  }, [blob, id, kind, type]);
  const href = url && url.id === id ? url.href : null;

  const move = useCallback((step: number) => {
    if (attachments.length < 2) return;
    setCurrentId(attachments[(index + step + attachments.length) % attachments.length].id);
    setPdfZoom(null);
    setPdfPages(null);
  }, [attachments, index]);

  if (!attachment) return null;
  const download = () => {
    if (current && 'blob' in current) void saveFile(current.blob, current.filename || attachment.filename || 'attachment').catch(() => fallbackDownload(attachment));
    else void fallbackDownload(attachment);
  };
  const runInApp = async (action: AppFileAction) => {
    if (!appFiles || running) return;
    setRunning(action);
    try {
      const ticket = await createFileTicket({ kind: 'mail-attachment', id: attachment.id });
      await appFiles.run(action, { url: ticket.url, name: ticket.filename || attachment.filename || 'attachment', type: ticket.content_type });
    } catch (error) {
      toast({ title: action === 'save' ? 'Could not save the file' : 'Could not hand over the file', description: error instanceof Error && error.message ? error.message : 'Try again.', variant: 'destructive' });
    } finally {
      setRunning(null);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if ((event.target as HTMLElement).closest('input, textarea, select, audio, video, [contenteditable="true"]')) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
  };
  const pdfScale = pdfZoom ?? pdfFit;
  const zoomBy = (step: number) => setPdfZoom(Math.min(3, Math.max(0.5, Math.round((pdfScale + step) * 4) / 4)));

  const downloadButton = appFiles
    ? <Button type="button" disabled={running !== null} onClick={() => void runInApp('open')}><SquareArrowOutUpRight aria-hidden="true" />Open with…</Button>
    : <Button type="button" onClick={download}><Download aria-hidden="true" />Download</Button>;
  const fileLine = `${attachment.filename} · ${formatAttachmentSize(attachment.size_bytes)}`;
  let body: ReactNode;
  if (!current) body = <LoadingState label="Loading attachment…" className="h-full" />;
  else if ('error' in current) {
    body = <EmptyState title="Could not load this attachment" description={loadErrorMessage(current.error)} className="h-full px-4"
      action={<Button type="button" variant="outline" onClick={() => { setLoaded(null); setAttempt(value => value + 1); }}>Try again</Button>} />;
  } else if (kind === 'none') {
    body = <EmptyState icon={FileQuestion} title="No preview for this file type" description={<>{fileLine}<br />{appFiles ? 'Open it in another app.' : 'Download it to open it in another app.'}</>}
      action={downloadButton} className="h-full px-4" />;
  } else if (kind === 'pdf') {
    body = <PdfPreview key={id} blob={current.blob} zoom={pdfZoom} onFitScale={setPdfFit} onPages={setPdfPages} download={downloadButton} />;
  } else if (kind === 'text' || kind === 'html') {
    body = <TextPreview key={id} blob={current.blob} html={kind === 'html'} fileLine={fileLine} download={downloadButton} />;
  } else if (!href) {
    body = <LoadingState label="Loading attachment…" className="h-full" />;
  } else if (kind === 'image') {
    body = <ImagePreview key={id} src={href} alt={attachment.filename} fileLine={fileLine} download={downloadButton} />;
  } else if (kind === 'audio') {
    body = <div className="flex h-full items-center justify-center p-4"><audio controls src={href} className="w-full max-w-md" /></div>;
  } else {
    body = <div className="flex h-full items-center justify-center p-2 sm:p-4"><video controls playsInline src={href} className="max-h-full max-w-full" /></div>;
  }

  const showPdfControls = kind === 'pdf' && pdfPages !== null;
  return (
    <DialogContent onKeyDown={onKeyDown}
      className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden border-0 p-0 sm:h-[90dvh] sm:w-[calc(100vw-2rem)] sm:max-w-5xl sm:rounded-lg sm:border [&>button:last-child]:hidden">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-background px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:flex-nowrap sm:px-3 sm:pt-2">
        <div className="order-1 min-w-0 flex-1 pl-1">
          <DialogTitle className="truncate text-sm font-medium leading-5">{attachment.filename}</DialogTitle>
          <DialogDescription className="truncate text-xs text-muted-foreground">
            {formatAttachmentSize(attachment.size_bytes)}
            {attachments.length > 1 && ` · ${index + 1} of ${attachments.length}`}
            {showPdfControls && ` · Page ${pdfPages.current} of ${pdfPages.total}`}
          </DialogDescription>
        </div>
        <div className="order-3 flex w-full items-center gap-1 sm:order-2 sm:w-auto">
          {showPdfControls && <div className="flex items-center">
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" title="Zoom out" disabled={pdfScale <= 0.5} onClick={() => zoomBy(-0.25)}><Minus aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" className="w-14 px-0 tabular-nums" aria-label={`Fit to width (now ${Math.round(pdfScale * 100)}%)`} title="Fit to width"
              onClick={() => setPdfZoom(null)}>{Math.round(pdfScale * 100)}%</Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom in" title="Zoom in" disabled={pdfScale >= 3} onClick={() => zoomBy(0.25)}><Plus aria-hidden="true" /></Button>
          </div>}
          <div className="ml-auto flex items-center gap-1">
            {appFiles ? <>
              <Button type="button" variant="ghost" className="px-3" aria-label="Open with…" title="Open with…" disabled={running !== null} onClick={() => void runInApp('open')}>
                <SquareArrowOutUpRight aria-hidden="true" /><span className="hidden md:inline">Open with…</span>
              </Button>
              <Button type="button" variant="ghost" className="px-3" aria-label="Save to Downloads" title="Save to Downloads" disabled={running !== null} onClick={() => void runInApp('save')}>
                <Download aria-hidden="true" /><span className="hidden md:inline">Save</span>
              </Button>
              <Button type="button" variant="ghost" className="px-3" aria-label="Share" title="Share" disabled={running !== null} onClick={() => void runInApp('share')}>
                <Share2 aria-hidden="true" /><span className="hidden md:inline">Share</span>
              </Button>
            </> : <>
              {href && canOpenInTab(kind, type) && (
                <Button asChild variant="ghost" className="px-3" aria-label="Open in new tab" title="Open in new tab">
                  <a href={href} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" /><span className="hidden md:inline">Open in new tab</span></a>
                </Button>
              )}
              <Button type="button" variant="ghost" className="px-3" aria-label="Download" title="Download" onClick={download}>
                <Download aria-hidden="true" /><span className="hidden md:inline">Download</span>
              </Button>
            </>}
            {attachments.length > 1 && <>
              <Button type="button" variant="ghost" size="icon" aria-label="Previous attachment" title="Previous attachment (Left arrow)" onClick={() => move(-1)}><ChevronLeft aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Next attachment" title="Next attachment (Right arrow)" onClick={() => move(1)}><ChevronRight aria-hidden="true" /></Button>
            </>}
          </div>
        </div>
        <DialogClose asChild>
          <Button type="button" variant="ghost" size="icon" className="order-2 sm:order-3" aria-label="Close" title="Close (Esc)"><X aria-hidden="true" /></Button>
        </DialogClose>
      </header>
      <div className="relative min-h-0 flex-1 bg-muted pb-[env(safe-area-inset-bottom)]">{body}</div>
    </DialogContent>
  );
}

function ImagePreview({ src, alt, fileLine, download }: { src: string; alt: string; fileLine: string; download: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <EmptyState icon={FileQuestion} title="Could not show this image" description={<>{fileLine}<br />This browser cannot display its format.</>} action={download} className="h-full px-4" />;
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-2 sm:p-4">
      <img src={src} alt={alt} onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

function TextPreview({ blob, html, fileLine, download }: { blob: Blob; html: boolean; fileLine: string; download: ReactNode }) {
  const tooLarge = blob.size > TEXT_LIMIT_BYTES;
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (tooLarge) return;
    let cancelled = false;
    void blob.text().then(value => { if (!cancelled) setText(value); });
    return () => { cancelled = true; };
  }, [blob, tooLarge]);
  // The same inert projection as HTML mail: no scripts, remote images or forms; the empty sandbox also stops links.
  const srcDoc = useMemo(() => html && text !== null
    ? emailSrcDoc(prepareEmailHtml(text, { allowRemoteImages: false, blockSuspectedTrackers: true }).html, false) : null, [html, text]);
  if (tooLarge) return <EmptyState title="This file is too large to show here" description={<>{fileLine}<br />Files up to 2 MB are shown. Download it to read all of it.</>} action={download} className="h-full px-4" />;
  if (text === null) return <LoadingState label="Loading attachment…" className="h-full" />;
  if (srcDoc !== null) {
    return (
      <div className="flex h-full flex-col gap-2 p-2 sm:p-4">
        <p className="text-xs text-muted-foreground">Shown without scripts, remote images or working links.</p>
        <iframe title="Attachment content" sandbox="" srcDoc={srcDoc} referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 rounded-md border border-border bg-background" />
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto p-2 sm:p-4">
      <pre className="mx-auto max-w-4xl whitespace-pre-wrap break-words rounded-md bg-background p-4 font-mono text-sm text-foreground">{text}</pre>
    </div>
  );
}

// Browsers refuse or blank canvases above about 16.7 million pixels (iOS), so sharpness gives way at high zoom.
const MAX_CANVAS_PIXELS = 16_000_000;

interface PdfPreviewProps {
  blob: Blob;
  /** Scale chosen with the zoom buttons; null fits the page width. */
  zoom: number | null;
  onFitScale: (scale: number) => void;
  onPages: (pages: { current: number; total: number }) => void;
  download: ReactNode;
}

/**
 * Draws the PDF with pdf.js rather than the browser's own viewer, which phones
 * (Android Chrome) do not offer inside a page. Each page gets pdf.js's text
 * layer so text such as an IBAN can be selected and copied.
 */
function PdfPreview({ blob, zoom, onFitScale, onPages, download }: PdfPreviewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pageElements = useRef<(HTMLDivElement | null)[]>([]);
  const position = useRef(0);
  const [pdf, setPdf] = useState<{ pdfjs: PdfJs; document: PDFDocumentProxy; sizes: { width: number; height: number }[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | null = null;
    (async () => {
      const pdfjs = await loadPdfJs();
      const data = new Uint8Array(await blob.arrayBuffer());
      if (cancelled) return;
      const task = pdfjs.getDocument(pdfDocumentOptions(data));
      destroy = () => task.destroy();
      const document = await task.promise;
      const sizes: { width: number; height: number }[] = [];
      for (let number = 1; number <= document.numPages; number++) {
        const { width, height } = (await document.getPage(number)).getViewport({ scale: 1 });
        sizes.push({ width, height });
      }
      if (cancelled) return;
      setPdf({ pdfjs, document, sizes });
      onPages({ current: 1, total: document.numPages });
    })().catch((error: unknown) => {
      if (cancelled) return;
      console.warn('PDF preview failed', error);
      setFailure(pdfFailureDetail(error));
    });
    return () => { cancelled = true; void destroy?.(); };
  }, [blob, onPages]);

  // Fit to the viewer's width; rotating a phone or resizing the window re-fits after a short pause.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setWidth(element.clientWidth), 150);
    });
    observer.observe(element);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [pdf]);

  const padding = width < 640 ? 8 : 24;
  const fitScale = pdf && width > 0 ? Math.max(0.1, (width - 2 * padding) / pdf.sizes[0].width) : 1;
  const scale = zoom ?? fitScale;
  useEffect(() => { onFitScale(fitScale); }, [fitScale, onFitScale]);

  // Draw the pages within a viewport of the visible area and let go of the
  // others, so a long PDF holds a few canvases rather than one per page.
  useEffect(() => {
    if (!pdf) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(new Set(pdf.sizes.map((_, index) => index))); return; }
    const observer = new IntersectionObserver(entries => {
      setNear(previous => {
        const next = new Set(previous);
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) next.add(page); else next.delete(page);
        }
        return next;
      });
    }, { root: scroller.current, rootMargin: '100% 0px' });
    pageElements.current.forEach(element => { if (element) observer.observe(element); });
    return () => observer.disconnect();
  }, [pdf]);

  // Stay at the same place in the document when the zoom changes.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = position.current * element.scrollHeight;
  }, [scale]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element || !pdf) return;
    position.current = element.scrollHeight ? element.scrollTop / element.scrollHeight : 0;
    const line = element.scrollTop + element.clientHeight / 3;
    let current = 1;
    pageElements.current.forEach((page, index) => { if (page && page.offsetTop <= line) current = index + 1; });
    onPages({ current, total: pdf.sizes.length });
  };

  if (failure !== null) {
    return <EmptyState icon={FileQuestion} title="Could not show this PDF"
      description={<>It may be damaged or use features this viewer does not support. Download it to open it in another app.
        <span className="mt-2 block break-words font-mono text-xs">{failure}</span></>}
      action={download} className="h-full px-4" />;
  }
  return (
    <div ref={scroller} onScroll={onScroll} className="relative h-full overflow-auto">
      {!pdf ? <LoadingState label="Opening PDF…" className="h-full" /> : (
        <div className="flex w-max min-w-full flex-col items-center gap-3" style={{ padding }}>
          {pdf.sizes.map((size, index) => (
            <div key={index} ref={element => { pageElements.current[index] = element; }} data-page={index}>
              <PdfPage pdfjs={pdf.pdfjs} pdfDocument={pdf.document} number={index + 1} scale={scale} size={size} active={near.has(index)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PdfPage({ pdfjs, pdfDocument, number, scale, size, active }: {
  pdfjs: PdfJs; pdfDocument: PDFDocumentProxy; number: number; scale: number; size: { width: number; height: number }; active: boolean;
}) {
  const canvasHolder = useRef<HTMLDivElement>(null);
  const textHolder = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    if (!active) {
      // Far from view: free the drawing (a zero-sized canvas releases its memory
      // at once on iOS) and show the placeholder; it is drawn again on the way back.
      const canvas = canvasHolder.current?.querySelector('canvas');
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      canvasHolder.current?.replaceChildren();
      textHolder.current?.replaceChildren();
      setDrawn(false);
      return;
    }
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: PdfTextLayer | null = null;
    (async () => {
      const page = await pdfDocument.getPage(number);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      // Draw off-screen and swap, so zooming never shows a blank page.
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.className = 'block h-full w-full';
      renderTask = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (cancelled) return;
      canvasHolder.current?.replaceChildren(canvas);
      setDrawn(true);
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
      await textLayer.render();
      if (!cancelled) textHolder.current?.replaceChildren(layer);
    })().catch(() => { /* A cancelled or failed page keeps its previous drawing. */ });
    return () => { cancelled = true; renderTask?.cancel(); textLayer?.cancel(); };
  }, [active, pdfDocument, number, scale, pdfjs]);

  const style = {
    width: Math.floor(size.width * scale), height: Math.floor(size.height * scale),
    // Read by pdf.js's text layer to size and place the selectable text.
    '--total-scale-factor': scale, '--scale-round-x': '1px', '--scale-round-y': '1px',
  } as CSSProperties;
  return (
    <div className="relative bg-background shadow-sm" style={style}>
      <div ref={canvasHolder} className="absolute inset-0" />
      {!drawn && <div aria-hidden="true" className="absolute inset-0 bg-muted-foreground/10 motion-safe:animate-pulse" />}
      <div ref={textHolder} className="absolute inset-0" />
    </div>
  );
}
