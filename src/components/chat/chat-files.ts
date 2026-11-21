// Chat files in the screens: what may be drawn, and fetching and saving one.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatEngine } from '@/lib/chat/types';
import { handOverFile, saveFile, type AppHandOver } from '@/lib/platform';
import { useSessionScope } from '@/lib/session-scope';
import { useToast } from '@/hooks/use-toast';

// A file's name and type are its sender's choice. A file is therefore only
// ever drawn by <img> (these four types), by the PDF reader's canvas or
// played by <audio>, under a type chosen here; anything else is saved.
const PICTURE = /^image\/(jpeg|png|webp|gif)$/;
/** The sound types <audio> may play a voice message as. */
export const AUDIO = /^audio\/(webm|mp4|ogg|mpeg|wav|aac)/;

/** The type an <img> may show the file as; null for anything else. */
export const pictureType = (file: { type: string }) => PICTURE.exec(file.type)?.[0] ?? null;
export const isPdf = (file: { type: string; name: string }) => file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name));

/** An address for a Blob while the component shows it, under the given type; revoked when either goes. */
export function useObjectUrl(blob: Blob | null, type: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const href = URL.createObjectURL(new Blob([blob], { type }));
    setUrl(href);
    return () => { URL.revokeObjectURL(href); setUrl(null); };
  }, [blob, type]);
  return url;
}

/**
 * Fetches a file of a message once asked: `progress` (0 to 1) on the way, then
 * `blob` (with `keep`; a file that is only saved is not held on to). Leaving
 * the chat stops the fetch, and an answer that comes later is dropped.
 */
export function useChatFile(engine: ChatEngine, messageId: string, fileId: string) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const fetching = useRef<AbortController | null>(null);
  useEffect(() => () => { fetching.current?.abort(); fetching.current = null; setBlob(null); setProgress(null); setFailed(null); }, [engine, messageId, fileId]);
  const fetch = useCallback(async (keep = true) => {
    if (fetching.current) return null;
    const controller = fetching.current = new AbortController();
    setProgress(0);
    setFailed(null);
    try {
      const got = await engine.openFile(messageId, fileId, { signal: controller.signal, onProgress: part => { if (!controller.signal.aborted) setProgress(part); } });
      if (controller.signal.aborted) return null;
      if (keep) setBlob(got);
      return got;
    } catch (error) {
      if (!controller.signal.aborted) setFailed(error instanceof Error && error.message ? error.message : 'The file could not be fetched.');
      return null;
    } finally {
      if (fetching.current === controller) { fetching.current = null; setProgress(null); }
    }
  }, [engine, messageId, fileId]);
  return { blob, progress, failed, fetch };
}

/**
 * Saves a Blob as a file on this device (in the Android app: to Downloads), or
 * hands it to Android's Open with or Share where the app offers them
 * (`appHandsOverFiles`); says so when that fails.
 */
export function useSaveFile() {
  const { toast } = useToast();
  const scope = useSessionScope();
  return useCallback((blob: Blob, name: string, target?: AppHandOver) => {
    (target ? handOverFile(blob, name, target) : saveFile(blob, name)).catch((error: unknown) => {
      if (!scope.ended) toast({ title: target ? 'Could not hand over the file' : 'Could not save the file', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    });
  }, [toast, scope]);
}
