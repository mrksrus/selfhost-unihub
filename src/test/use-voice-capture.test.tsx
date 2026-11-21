import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_VOICE_SECONDS, useVoiceCapture, type VoiceRecording } from '@/hooks/use-voice-capture';

// The voice recorder with the browser's recorder and microphone faked.

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const track = { stop: vi.fn() };
let answer: (stream: unknown) => void = () => {};
class FakeRecorder {
  static isTypeSupported = (type: string) => type.startsWith('audio/mp4');
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, public options: { mimeType: string }) {}
  get mimeType() { return this.options.mimeType; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['aac'], { type: this.mimeType }) });
    this.onstop?.();
  }
}
vi.stubGlobal('MediaRecorder', FakeRecorder);
Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
  value: { getUserMedia: () => new Promise(resolve => { answer = resolve; }) } });
const microphone = () => answer({ getTracks: () => [track] });

afterEach(() => { vi.useRealTimers(); track.stop.mockClear(); });

describe('a voice message', () => {
  it('stops by itself at ten minutes in the type the browser offers; a discarded one gives nothing', async () => {
    vi.useFakeTimers();
    const recorded: VoiceRecording[] = [];
    const { result } = renderHook(() => useVoiceCapture(recording => recorded.push(recording)));
    let started!: Promise<void>;
    act(() => { started = result.current.start(); });
    await act(async () => { microphone(); await started; });
    expect(result.current.state).toBe('recording');
    act(() => { vi.advanceTimersByTime(65_000); });
    expect(result.current.seconds).toBe(65);
    act(() => { vi.advanceTimersByTime(MAX_VOICE_SECONDS * 1000); });
    expect(result.current.state).toBe('idle');
    expect(recorded).toMatchObject([{ type: 'audio/mp4;codecs=mp4a.40.2', name: 'Voice message.m4a', seconds: MAX_VOICE_SECONDS }]);
    expect(track.stop).toHaveBeenCalled();

    act(() => { started = result.current.start(); });
    await act(async () => { microphone(); await started; });
    act(() => result.current.discard());
    expect([recorded.length, result.current.state]).toEqual([1, 'idle']);
  });

  it('discarded while the microphone is still asked for, it releases the microphone when it arrives and records nothing', async () => {
    const recorded: VoiceRecording[] = [];
    const { result } = renderHook(() => useVoiceCapture(recording => recorded.push(recording)));
    let started!: Promise<void>;
    act(() => { started = result.current.start(); });
    expect(result.current.state).toBe('starting');
    act(() => result.current.finish());
    await act(async () => { microphone(); await started; });
    expect([result.current.state, recorded.length, track.stop.mock.calls.length]).toEqual(['idle', 0, 1]);
  });
});
