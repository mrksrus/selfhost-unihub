import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';

/** A voice message stops by itself at this length. */
export const MAX_VOICE_SECONDS = 600;
// The receiving browser plays what this one recorded: Opus in WebM where offered (Chrome, Firefox, Android), else AAC in MP4 (Safari).
const TYPES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];

export interface VoiceRecording {
  blob: Blob;
  /** The type the browser recorded, e.g. "audio/webm;codecs=opus". */
  type: string;
  /** A name for the file, with the type's extension. */
  name: string;
  seconds: number;
}

interface Session { recorder: MediaRecorder | null; stream: MediaStream | null; keep: boolean; cancelled: boolean; startedAt: number }

/**
 * A voice message with the browser's own recorder: `start()` asks for the
 * microphone, `seconds` counts while `recording`, `finish()` hands the
 * recording to `onRecorded`, `discard()` drops it. Leaving the page discards.
 */
export function useVoiceCapture(onRecorded: (recording: VoiceRecording) => void) {
  const { toast } = useToast();
  const [state, setState] = useState<'idle' | 'starting' | 'recording'>('idle');
  const [seconds, setSeconds] = useState(0);
  const session = useRef<Session | null>(null);
  const recorded = useRef(onRecorded);
  recorded.current = onRecorded;

  const end = useCallback((keep: boolean) => {
    const current = session.current;
    if (!current) return;
    current.keep = keep;
    if (current.recorder) { if (current.recorder.state !== 'inactive') current.recorder.stop(); return; }
    // Ended while the microphone was still being asked for: its stream is released on arrival.
    current.cancelled = true;
    session.current = null;
    setState('idle');
  }, []);

  const start = useCallback(async () => {
    if (session.current) return;
    const type = typeof MediaRecorder === 'undefined' ? undefined : TYPES.find(item => MediaRecorder.isTypeSupported(item));
    if (!navigator.mediaDevices?.getUserMedia || !type) {
      toast({ title: 'Voice messages cannot be recorded in this browser', variant: 'destructive' });
      return;
    }
    const current: Session = { recorder: null, stream: null, keep: false, cancelled: false, startedAt: 0 };
    session.current = current;
    setState('starting');
    setSeconds(0);
    try {
      current.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (session.current === current) { session.current = null; setState('idle'); }
      const name = (error as { name?: string } | null)?.name;
      toast({ title: 'Could not start recording', variant: 'destructive', description: name === 'NotAllowedError' || name === 'SecurityError'
        ? 'UniHub may not use the microphone. Allow the microphone for this site in the browser, or for the app in Android\'s settings, then try again.'
        : name === 'NotFoundError' ? 'No microphone was found on this device.' : error instanceof Error ? error.message : 'Microphone access failed' });
      return;
    }
    const stream = current.stream;
    if (current.cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: type });
      recorder.start(1000);
    } catch (error) {
      // The microphone must not stay on behind a recorder that never started.
      stream.getTracks().forEach(track => track.stop());
      if (session.current === current) { session.current = null; setState('idle'); }
      toast({ title: 'Could not start recording', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
      return;
    }
    current.recorder = recorder;
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      if (session.current === current) { session.current = null; setState('idle'); }
      if (!current.keep) return;
      const chosen = recorder.mimeType || type;
      const length = Math.min(MAX_VOICE_SECONDS, Math.round((Date.now() - current.startedAt) / 1000));
      recorded.current({ blob: new Blob(chunks, { type: chosen }), type: chosen, name: `Voice message.${chosen.startsWith('audio/mp4') ? 'm4a' : 'webm'}`, seconds: length });
    };
    current.startedAt = Date.now();
    setState('recording');
  }, [toast]);

  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => {
      const elapsed = (Date.now() - (session.current?.startedAt ?? Date.now())) / 1000;
      setSeconds(Math.floor(elapsed));
      if (elapsed >= MAX_VOICE_SECONDS) end(true);
    }, 250);
    return () => clearInterval(timer);
  }, [state, end]);

  useEffect(() => () => end(false), [end]);

  return { state, seconds, start, finish: useCallback(() => end(true), [end]), discard: useCallback(() => end(false), [end]) };
}
