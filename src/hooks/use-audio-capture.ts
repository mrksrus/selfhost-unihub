import { useEffect, useRef, useState } from 'react';
import { createPcm16WavBlob } from '@/lib/wav';
import { appendCaptureBatch, createCapture, deleteCapture, finishCapture, listCaptures, recoverCapture } from '@/lib/recording-queue';
import { useToast } from '@/hooks/use-toast';

// Audio of a running recording is written to the device this often, so a
// crash or a closed app loses at most this much.
const CAPTURE_FLUSH_MS = 2000;
const VOICE_PROCESSING = ['autoGainControl', 'noiseSuppression', 'echoCancellation'] as const;
const VOICE_PROCESSING_LABELS: Record<typeof VOICE_PROCESSING[number], string> = {
  autoGainControl: 'automatic volume',
  noiseSuppression: 'noise suppression',
  echoCancellation: 'echo cancellation',
};

export type CaptureState = 'idle' | 'recording' | 'paused';

/** A finished recording: WAV audio, and the device copy that keeps it until it is saved. */
export interface CapturedAudio {
  blob: Blob;
  filename: string;
  title: string;
  durationSeconds: number;
  stoppedAt: Date;
  // The draft kept on this device, when the browser allows it.
  jobId: string | null;
}

function captureLockName(id: string) {
  return `unihub-capture:${id}`;
}

// Automatic volume control makes the level of music rise and fall. The
// browser may ignore the request in getUserMedia, so check what it applied.
async function disableVoiceProcessing(track: MediaStreamTrack) {
  const active = () => {
    const settings = track.getSettings();
    return VOICE_PROCESSING.filter(key => settings[key] === true);
  };
  if (active().length) {
    await track.applyConstraints({ autoGainControl: false, noiseSuppression: false, echoCancellation: false }).catch(() => {});
  }
  return active();
}

interface Options {
  userId: string | undefined;
  /** The name typed so far; a recording stopped without one gets a dated name. */
  draftTitle: string;
  onStart: () => void;
  onCaptured: (audio: CapturedAudio) => void;
}

/**
 * Microphone recording as uncompressed WAV. While recording, the audio is
 * written to the device in batches, so an interrupted recording (closed app,
 * crash, reload) is recovered as a draft on the next visit.
 */
export function useAudioCapture({ userId, draftTitle, onStart, onCaptured }: Options) {
  const { toast } = useToast();
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recorderWorkletRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const pcmChunksRef = useRef<ArrayBuffer[]>([]);
  const pcmSampleCountRef = useRef(0);
  const pcmSampleRateRef = useRef(44100);
  const workletStoppedResolveRef = useRef<(() => void) | null>(null);
  const stopInProgressRef = useRef(false);
  const captureIdRef = useRef<string | null>(null);
  const captureBatchRef = useRef<ArrayBuffer[]>([]);
  const captureBatchSamplesRef = useRef(0);
  const captureWritesRef = useRef<Promise<void>>(Promise.resolve());
  const captureFailedRef = useRef(false);
  const captureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureReleaseRef = useRef<(() => void) | null>(null);
  const interruptionShownRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const pausedMsRef = useRef(0);
  // The start waiting for the microphone, if any: a second Record joins it.
  // Its token tells a start that was cancelled while the browser still asked
  // (page left, account switched) to release what it got and touch nothing.
  const startInFlightRef = useRef<Promise<void> | null>(null);
  const startTokenRef = useRef(0);
  const [state, setState] = useState<CaptureState>('idle');
  const [starting, setStarting] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Read when the recording stops, which can happen from a device event long
  // after the render that started it.
  const latest = useRef({ draftTitle, onStart, onCaptured });
  latest.current = { draftTitle, onStart, onCaptured };

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setInterval(() => {
      if (!startedAtRef.current) return;
      const now = state === 'paused' && pausedAtRef.current ? pausedAtRef.current : Date.now();
      const elapsed = Math.max(0, now - startedAtRef.current - pausedMsRef.current);
      setElapsedSeconds(elapsed / 1000);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  // A start still waiting for the microphone belongs to this page and
  // account: leaving either cancels it.
  useEffect(() => () => { cancelPendingStart(); }, [userId]);

  useEffect(() => () => {
    // Leaving the page mid-recording keeps what was captured. The next visit
    // recovers it as a draft.
    persistCaptureBatch();
    if (captureTimerRef.current) clearInterval(captureTimerRef.current);
    const release = captureReleaseRef.current;
    void captureWritesRef.current.finally(() => release?.());
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderWorkletRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    void audioContextRef.current?.close();
  }, []);

  // Interrupted recordings (closed app, crash, reload) are rebuilt from the
  // audio written while recording. A capture still locked belongs to a
  // recording running in another tab.
  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    const recover = async (capture: Awaited<ReturnType<typeof listCaptures>>[number]) => {
      const startedAt = new Date(capture.startedAt);
      const job = await recoverCapture(capture, {
        title: `Recovered recording ${startedAt.toLocaleString()}`,
        original_filename: `recording-${startedAt.toISOString().replace(/[:.]/g, '-')}.wav`,
        content_type: 'audio/wav',
        duration_seconds: null,
        source: 'recorded',
        category: 'none',
        recorded_at: startedAt.toISOString(),
        metadata: {},
        tags: [],
      });
      if (job && !cancelled) {
        toast({ title: 'Interrupted recording recovered', description: 'It is listed under "On this device". Check it and save it.' });
      }
    };
    void (async () => {
      for (const capture of await listCaptures(userId)) {
        if (cancelled) return;
        if (navigator.locks) {
          await navigator.locks.request(captureLockName(capture.id), { ifAvailable: true }, async lock => {
            if (lock) await recover(capture);
          });
        } else if (Date.now() - capture.updatedAt > 60 * 60 * 1000) {
          await recover(capture);
        }
      }
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [toast, userId]);

  useEffect(() => {
    if (state === 'idle') return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  // Writes the audio received since the last write. Writes run one after the
  // other so batches keep their order.
  function persistCaptureBatch() {
    const captureId = captureIdRef.current;
    if (!captureId || captureFailedRef.current || !captureBatchRef.current.length) return captureWritesRef.current;
    const batch = new Blob(captureBatchRef.current);
    const samples = captureBatchSamplesRef.current;
    captureBatchRef.current = [];
    captureBatchSamplesRef.current = 0;
    captureWritesRef.current = captureWritesRef.current
      .then(() => appendCaptureBatch(captureId, batch, samples))
      .catch(() => { captureFailedRef.current = true; });
    return captureWritesRef.current;
  }

  // Holds a lock for the whole recording, so a recovery in another tab
  // leaves this capture alone. Returns the capture the recording writes to,
  // or null when this browser cannot store it. Nothing is written to the
  // hook's refs: the start adopts the capture once it is sure it is current.
  const openCapture = async (sampleRate: number): Promise<{ id: string; release: (() => void) | null } | null> => {
    if (!userId) return null;
    const captureId = crypto.randomUUID();
    const lock: { release: (() => void) | null } = { release: null };
    try {
      if (navigator.locks) {
        await new Promise<void>((acquired) => {
          void navigator.locks.request(captureLockName(captureId), () => {
            acquired();
            return new Promise<void>((release) => { lock.release = release; });
          });
        });
      }
      const now = Date.now();
      await createCapture({ id: captureId, userId, sampleRate, sampleCount: 0, batches: 0, startedAt: now, updatedAt: now });
      return { id: captureId, release: lock.release };
    } catch {
      lock.release?.();
      toast({ title: 'Recording is kept in memory only', description: 'This browser does not allow storing it on the device. Keep the app open until you save it.' });
      return null;
    }
  };

  const endCapture = () => {
    if (captureTimerRef.current) clearInterval(captureTimerRef.current);
    captureTimerRef.current = null;
    captureReleaseRef.current?.();
    captureReleaseRef.current = null;
    captureIdRef.current = null;
    captureBatchRef.current = [];
    captureBatchSamplesRef.current = 0;
  };

  const releaseRecordingResources = async () => {
    recorderWorkletRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    await audioContextRef.current?.close().catch(() => {});
    recorderWorkletRef.current = null;
    audioSourceRef.current = null;
    silentGainRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
  };

  // Forgets the start waiting for the microphone. When its stream arrives,
  // that start stops the tracks it was given and leaves the refs alone, so a
  // later start is never mixed with it.
  const cancelPendingStart = () => {
    if (!startInFlightRef.current) return;
    startTokenRef.current += 1;
    startInFlightRef.current = null;
    setStarting(false);
  };

  // One start at a time: Record while the browser (or Android) still asks for
  // the microphone joins the pending start instead of asking again. The
  // stream, context and worklet stay local until the last await is over, so a
  // start that fails, or was cancelled meanwhile, releases only its own.
  const start = (): Promise<void> => {
    if (startInFlightRef.current) return startInFlightRef.current;
    if (recorderWorkletRef.current) return Promise.resolve();
    const AudioContextClass = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextClass || typeof AudioWorkletNode === 'undefined') {
      toast({ title: 'Recording is not available in this browser', variant: 'destructive' });
      return Promise.resolve();
    }

    const token = ++startTokenRef.current;
    const stale = () => token !== startTokenRef.current;
    setStarting(true);
    const run = (async () => {
      let stream: MediaStream | null = null;
      let audioContext: AudioContext | null = null;
      let capture: Awaited<ReturnType<typeof openCapture>> = null;
      const discard = async () => {
        stream?.getTracks().forEach((track) => track.stop());
        await audioContext?.close().catch(() => {});
        if (capture) {
          capture.release?.();
          void deleteCapture(capture.id).catch(() => {});
        }
      };
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
          },
        });
        stream = mediaStream;
        if (stale()) return await discard();
        const track = mediaStream.getAudioTracks()[0];
        const processing = track ? await disableVoiceProcessing(track) : [];
        if (stale()) return await discard();
        if (processing.length) {
          toast({
            title: 'The browser keeps audio processing on',
            description: `It did not allow turning off ${processing.map(key => VOICE_PROCESSING_LABELS[key]).join(', ')}. The volume may change on its own during the recording.`,
          });
        }
        // Keep the microphone's rate where available so capture does not need an
        // extra resampling step. WAV records the actual context rate in its header.
        const sampleRate = track?.getSettings().sampleRate;
        const context = new AudioContextClass({
          ...(sampleRate ? { sampleRate } : {}),
          latencyHint: 'balanced',
        });
        audioContext = context;
        await context.audioWorklet.addModule('/audio-recorder-worklet.js');
        if (stale()) return await discard();
        const source = context.createMediaStreamSource(mediaStream);
        const worklet = new AudioWorkletNode(context, 'pcm-recorder', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
        });
        const silentGain = context.createGain();
        silentGain.gain.value = 0;
        source.connect(worklet);
        worklet.connect(silentGain);
        silentGain.connect(context.destination);
        await context.resume();
        if (stale()) return await discard();
        capture = await openCapture(context.sampleRate);
        if (stale()) return await discard();

        // Current and complete: from here on the recording is the hook's.
        streamRef.current = mediaStream;
        audioContextRef.current = context;
        audioSourceRef.current = source;
        recorderWorkletRef.current = worklet;
        silentGainRef.current = silentGain;
        pcmChunksRef.current = [];
        pcmSampleCountRef.current = 0;
        pcmSampleRateRef.current = context.sampleRate;
        startedAtRef.current = Date.now();
        pausedAtRef.current = null;
        pausedMsRef.current = 0;
        stopInProgressRef.current = false;
        setElapsedSeconds(0);
        interruptionShownRef.current = false;
        captureIdRef.current = capture?.id ?? null;
        captureReleaseRef.current = capture?.release ?? null;
        captureBatchRef.current = [];
        captureBatchSamplesRef.current = 0;
        captureFailedRef.current = false;
        captureWritesRef.current = Promise.resolve();
        if (capture) captureTimerRef.current = setInterval(() => void persistCaptureBatch(), CAPTURE_FLUSH_MS);
        latest.current.onStart();

        // A phone call or another app can take the microphone or suspend audio.
        // Keep what was recorded and tell the user.
        if (track) track.onended = () => {
          toast({ title: 'The microphone was turned off', description: 'The recording was stopped. What was recorded so far is kept.', variant: 'destructive' });
          void stop();
        };
        context.onstatechange = () => {
          if (context.state === 'running' || context.state === 'closed' || stopInProgressRef.current) return;
          void context.resume().catch(() => {});
          if (!interruptionShownRef.current) {
            interruptionShownRef.current = true;
            toast({ title: 'Recording was interrupted', description: 'The system paused audio. The recording may have a gap.', variant: 'destructive' });
          }
        };

        worklet.port.onmessage = (event: MessageEvent<{
          type?: string;
          buffer?: ArrayBuffer;
          samples?: number;
        }>) => {
          if (event.data.type === 'pcm' && event.data.buffer && event.data.samples) {
            pcmChunksRef.current.push(event.data.buffer);
            pcmSampleCountRef.current += event.data.samples;
            if (captureIdRef.current) {
              captureBatchRef.current.push(event.data.buffer);
              captureBatchSamplesRef.current += event.data.samples;
            }
          } else if (event.data.type === 'stopped') {
            workletStoppedResolveRef.current?.();
            workletStoppedResolveRef.current = null;
          }
        };
        setState('recording');
      } catch (error: unknown) {
        await discard();
        if (stale()) return;
        const message = error instanceof Error ? error.message : 'Microphone access failed';
        toast({ title: 'Could not start recording', description: message, variant: 'destructive' });
      } finally {
        if (!stale()) {
          startInFlightRef.current = null;
          setStarting(false);
        }
      }
    })();
    startInFlightRef.current = run;
    return run;
  };

  const pause = () => {
    const worklet = recorderWorkletRef.current;
    if (!worklet || state !== 'recording') return;
    worklet.port.postMessage({ type: 'pause' });
    pausedAtRef.current = Date.now();
    setState('paused');
  };

  const resume = () => {
    const worklet = recorderWorkletRef.current;
    if (!worklet || state !== 'paused') return;
    if (pausedAtRef.current) pausedMsRef.current += Date.now() - pausedAtRef.current;
    pausedAtRef.current = null;
    worklet.port.postMessage({ type: 'resume' });
    setState('recording');
  };

  const stop = async () => {
    const worklet = recorderWorkletRef.current;
    if (!worklet) {
      // Stopped before the microphone answered: the answer is released on arrival.
      cancelPendingStart();
      return;
    }
    if (stopInProgressRef.current) return;
    stopInProgressRef.current = true;

    try {
      const stopped = new Promise<void>((resolve) => {
        workletStoppedResolveRef.current = resolve;
      });
      worklet.port.postMessage({ type: 'stop' });
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let stopConfirmed = true;
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          stopTimer = setTimeout(() => { stopConfirmed = false; resolve(); }, 5000);
        }),
      ]);
      clearTimeout(stopTimer);
      // Detach before creating the Blob so late messages cannot add samples to a
      // preview that has already been finalized. Keep captured audio on timeout.
      worklet.port.onmessage = null;
      if (!stopConfirmed) {
        toast({ title: 'Please check the recording preview', description: 'The recorder took too long to stop. The final moment of audio may be missing.', variant: 'destructive' });
      }

      const sampleCount = pcmSampleCountRef.current;
      const sampleRate = pcmSampleRateRef.current;
      const blob = createPcm16WavBlob(pcmChunksRef.current, sampleRate, sampleCount);
      pcmChunksRef.current = [];
      pcmSampleCountRef.current = 0;
      const stoppedAt = new Date();
      const filename = `recording-${stoppedAt.toISOString().replace(/[:.]/g, '-')}.wav`;
      const recordingTitle = latest.current.draftTitle || `Recording ${stoppedAt.toLocaleString()}`;
      const durationSeconds = sampleCount / sampleRate;

      // The finished file replaces the capture on the device as a draft, so
      // it survives until it is saved or discarded.
      const captureId = captureIdRef.current;
      let jobId: string | null = null;
      if (captureId && userId && !captureFailedRef.current) {
        if (captureTimerRef.current) clearInterval(captureTimerRef.current);
        await captureWritesRef.current;
        try {
          await finishCapture(captureId, {
            id: captureId,
            userId,
            state: 'draft',
            details: {
              title: recordingTitle,
              original_filename: filename,
              content_type: 'audio/wav',
              duration_seconds: durationSeconds,
              source: 'recorded',
              category: 'none',
              recorded_at: stoppedAt.toISOString(),
              metadata: {},
              tags: [],
            },
            size: blob.size,
            bytesUploaded: 0,
            error: null,
            recovered: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }, blob);
          jobId = captureId;
        } catch {
          // The capture stays and is recovered on the next visit.
        }
      } else if (captureId) {
        // Writing failed part way. The full recording is in memory, so the
        // partial copy would only come back as a broken duplicate.
        void deleteCapture(captureId).catch(() => {});
      }
      endCapture();
      latest.current.onCaptured({ blob, filename, title: recordingTitle, durationSeconds, stoppedAt, jobId });
      setState('idle');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Could not finish WAV recording';
      toast({ title: 'Recording failed', description: message, variant: 'destructive' });
    } finally {
      workletStoppedResolveRef.current = null;
      setState('idle');
      endCapture();
      await releaseRecordingResources();
      stopInProgressRef.current = false;
    }
  };

  return { state, starting, elapsedSeconds, start, pause, resume, stop };
}
