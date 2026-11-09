import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Recordings from '@/pages/Recordings';
import { useAudioCapture } from '@/hooks/use-audio-capture';
import { api } from '@/lib/api';
import { createCapture, deleteCapture } from '@/lib/recording-queue';

// B-42: Record while the browser or Android still asks for the microphone.
// Only getUserMedia, the audio context and the worklet are faked; the page,
// the hook and the capture store run as they do in the browser.

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner', timezone: 'UTC' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn() } }));
vi.mock('@/hooks/use-recording-uploads', () => ({
  useStoredRecordings: () => ({ recordings: [], progress: {}, available: true }),
  pageUploadRequest: vi.fn(), kickRecordingUploads: vi.fn(), stopRecordingUploads: vi.fn(), closeUploadNotices: vi.fn(),
}));
vi.mock('@/lib/recording-queue', () => ({
  listCaptures: vi.fn(async () => []), createCapture: vi.fn(async () => {}), appendCaptureBatch: vi.fn(async () => {}),
  finishCapture: vi.fn(async () => {}), deleteCapture: vi.fn(async () => {}), recoverCapture: vi.fn(async () => null),
  canDiscardQueuedRecordings: () => true, deleteStoredRecording: vi.fn(), discardStoredRecording: vi.fn(), readStoredRecordingBlob: vi.fn(),
  saveStoredRecording: vi.fn(), updateStoredRecording: vi.fn(),
}));

type Deferred = { resolve: (stream: FakeStream) => void; reject: (error: Error) => void };
type FakeTrack = { stop: ReturnType<typeof vi.fn>; getSettings: () => { sampleRate: number }; applyConstraints: () => Promise<void>; onended: null };
type FakeStream = { getTracks: () => FakeTrack[]; getAudioTracks: () => FakeTrack[] };

const fakeTrack = (): FakeTrack => ({ stop: vi.fn(), getSettings: () => ({ sampleRate: 48000 }), applyConstraints: async () => {}, onended: null });
const fakeStream = (track: FakeTrack): FakeStream => ({ getTracks: () => [track], getAudioTracks: () => [track] });

const contexts: FakeAudioContext[] = [];
class FakeAudioContext {
  // Loading the worklet module: the test can hold it open.
  static addModule: () => Promise<void> = async () => {};
  sampleRate = 48000;
  state = 'running';
  destination = {};
  onstatechange: (() => void) | null = null;
  audioWorklet = { addModule: () => FakeAudioContext.addModule() };
  close = vi.fn(async () => { this.state = 'closed'; });
  resume = async () => {};
  constructor() { contexts.push(this); }
  createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
  createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
}
class FakeWorkletNode {
  port: { postMessage: (message: { type: string }) => void; onmessage: ((event: MessageEvent) => void) | null } = {
    postMessage: (message) => {
      if (message.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'stopped' } } as MessageEvent));
    },
    onmessage: null,
  };
  connect() {}
  disconnect() {}
}

const getUserMedia = vi.fn();
let pending: Deferred[] = [];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/recordings']}><Recordings /></MemoryRouter></QueryClientProvider>);
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  contexts.length = 0;
  pending = [];
  FakeAudioContext.addModule = async () => {};
  getUserMedia.mockImplementation(() => new Promise<FakeStream>((resolve, reject) => { pending.push({ resolve, reject }); }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  Object.defineProperty(window, 'AudioContext', { configurable: true, writable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, writable: true, value: FakeWorkletNode });
  URL.createObjectURL = () => 'blob:recording';
  URL.revokeObjectURL = () => {};
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/recordings')) return { data: { recordings: [] } };
    return { data: { modules: [] } };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Record while the microphone question is pending', () => {
  it('asks for the microphone once and runs one capture when Record is pressed twice', async () => {
    mount();
    // The panel's action, whatever it says while the browser asks.
    const action = () => screen.getByRole('button', { name: /^(Record|Starting recording)$/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Record' }));
    fireEvent.click(action());
    fireEvent.click(action());
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Starting recording' })).toBeDisabled();

    const track = fakeTrack();
    await act(async () => { pending[0].resolve(fakeStream(track)); });
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Starting recording' })).not.toBeInTheDocument();
    expect(track.stop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByText('Save the recording')).toBeInTheDocument());
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('releases a microphone that answers after the page was left', async () => {
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Record' }));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();

    const track = fakeTrack();
    await act(async () => { pending[0].resolve(fakeStream(track)); });
    await flush();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(0);
  });

  it('stops the microphone when a start is stopped before it answered, and lets a new start through', async () => {
    const hook = renderHook(() => useAudioCapture({ userId: 'owner', draftTitle: '', onStart: () => {}, onCaptured: () => {} }));
    let first: Promise<void> | undefined;
    act(() => { first = hook.result.current.start(); });
    expect(hook.result.current.starting).toBe(true);
    // Stop before the browser answered: a no-op for the recorder, a cancel for the start.
    await act(async () => { await hook.result.current.stop(); });
    expect(hook.result.current.starting).toBe(false);
    expect(hook.result.current.state).toBe('idle');

    const late = fakeTrack();
    await act(async () => { pending[0].resolve(fakeStream(late)); await first; });
    expect(late.stop).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(0);
    expect(hook.result.current.state).toBe('idle');

    // The cancelled start no longer blocks: the next Record asks again and records.
    act(() => { void hook.result.current.start(); });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    const track = fakeTrack();
    await act(async () => { pending[1].resolve(fakeStream(track)); });
    await waitFor(() => expect(hook.result.current.state).toBe('recording'));
    expect(contexts).toHaveLength(1);
    expect(late.stop).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('returns to idle with Record enabled when the microphone is refused (narrow layout)', async () => {
    window.matchMedia = ((query: string) => ({
      matches: true, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Record' }));
    const starting = await screen.findByRole('button', { name: 'Starting recording' });
    expect(starting).toBeDisabled();
    fireEvent.click(starting);
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => { pending[0].reject(new Error('Permission denied')); });
    const record = await screen.findByRole('button', { name: 'Record' });
    expect(record).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Starting recording' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not start recording', description: 'Permission denied' }));
    expect(contexts).toHaveLength(0);

    // Refused once is not refused for good: Record asks again.
    fireEvent.click(record);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('button', { name: 'Starting recording' })).toBeDisabled();
  });
});

// A start that already holds the microphone and its audio context while the
// worklet module or the device capture is still loading: cancelling it must
// let go of both at once, not when that wait ends (which may be never).
describe('cancelling a start that already holds the microphone', () => {
  const options = (userId: string) => ({ userId, draftTitle: '', onStart: () => {}, onCaptured: () => {} });
  let settleModule: () => void = () => {};
  const holdModule = () => {
    FakeAudioContext.addModule = () => new Promise<void>((resolve) => { settleModule = resolve; });
  };

  // Starts, grants the microphone and leaves the attempt waiting in addModule.
  async function startUntilModule(start: () => Promise<void>) {
    const track = fakeTrack();
    let run: Promise<void> | undefined;
    act(() => { run = start(); });
    await act(async () => { pending[0].resolve(fakeStream(track)); });
    await flush();
    expect(contexts).toHaveLength(1);
    expect(track.stop).not.toHaveBeenCalled();
    return { track, run: run! };
  }

  it('Stop lets go of them at once while the worklet module is still loading', async () => {
    holdModule();
    const hook = renderHook(() => useAudioCapture(options('owner')));
    const { track, run } = await startUntilModule(hook.result.current.start);
    await act(async () => { await hook.result.current.stop(); });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(hook.result.current.starting).toBe(false);
    expect(hook.result.current.state).toBe('idle');
    await act(async () => { settleModule(); await run; });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(createCapture).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('a track whose release throws still lets the audio context and the next start go', async () => {
    holdModule();
    const hook = renderHook(() => useAudioCapture(options('owner')));
    const { track, run } = await startUntilModule(hook.result.current.start);
    track.stop.mockImplementation(() => { throw new Error('synthetic track release failure'); });
    await act(async () => { await hook.result.current.stop(); });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(hook.result.current.starting).toBe(false);
    await act(async () => { settleModule(); await run; });
    expect(createCapture).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('leaving the page lets go of them at once while the worklet module is still loading', async () => {
    holdModule();
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Record' }));
    const track = fakeTrack();
    await act(async () => { pending[0].resolve(fakeStream(track)); });
    await flush();
    expect(contexts).toHaveLength(1);
    expect(track.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    await act(async () => { settleModule(); });
    await flush();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(createCapture).not.toHaveBeenCalled();
  });

  it('switching accounts lets go of them at once and opens no capture for the old account', async () => {
    holdModule();
    const hook = renderHook((props: { userId: string }) => useAudioCapture(options(props.userId)), { initialProps: { userId: 'owner' } });
    const { track, run } = await startUntilModule(hook.result.current.start);
    hook.rerender({ userId: 'other' });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(hook.result.current.starting).toBe(false);
    await act(async () => { settleModule(); await run; });
    expect(createCapture).not.toHaveBeenCalled();
    expect(hook.result.current.state).toBe('idle');
    hook.unmount();
  });

  it('Stop while the device capture is being created lets go at once and removes the capture when it lands', async () => {
    let settleCapture: () => void = () => {};
    vi.mocked(createCapture).mockImplementationOnce(() => new Promise<void>((resolve) => { settleCapture = resolve; }));
    const hook = renderHook(() => useAudioCapture(options('owner')));
    const { track, run } = await startUntilModule(hook.result.current.start);
    await flush();
    expect(createCapture).toHaveBeenCalledTimes(1);
    await act(async () => { await hook.result.current.stop(); });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(deleteCapture).not.toHaveBeenCalled();
    await act(async () => { settleCapture(); await run; });
    const captureId = vi.mocked(createCapture).mock.calls[0][0].id;
    expect(deleteCapture).toHaveBeenCalledWith(captureId);
    expect(hook.result.current.state).toBe('idle');
    hook.unmount();
  });

  it('a cancelled start never touches the start that replaces it', async () => {
    holdModule();
    const hook = renderHook(() => useAudioCapture(options('owner')));
    const { track: oldTrack, run: oldRun } = await startUntilModule(hook.result.current.start);
    const settleOldModule = settleModule;
    await act(async () => { await hook.result.current.stop(); });
    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);

    FakeAudioContext.addModule = async () => {};
    act(() => { void hook.result.current.start(); });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    const track = fakeTrack();
    await act(async () => { pending[1].resolve(fakeStream(track)); });
    await waitFor(() => expect(hook.result.current.state).toBe('recording'));
    expect(contexts).toHaveLength(2);

    await act(async () => { settleOldModule(); await oldRun; });
    expect(hook.result.current.state).toBe('recording');
    expect(track.stop).not.toHaveBeenCalled();
    expect(contexts[1].close).not.toHaveBeenCalled();
    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(createCapture).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});
