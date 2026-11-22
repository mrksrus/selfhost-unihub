import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { ChatCallLayer } from '@/components/chat/ChatCallLayer';
import type { CallView, ChatCalls } from '@/lib/chat/call';

// The call's screens over a page, with a fixed call in place of the server's: what the keyboard may and may not do to a call.
const state: { held: { calls: ChatCalls; call: CallView | null } | null } = { held: null };
vi.mock('@/hooks/use-chat-calls', () => ({ useChatCalls: () => state.held, useHandCallsToApp: () => undefined }));

const view = (fields: Partial<CallView>): CallView => ({
  id: 'call-1', conversation_id: 'chat-blair', peer: { user_id: 'user-blair', name: 'Blair Example' }, incoming: false, state: 'active', ended: null, reason: null,
  answered_at: new Date().toISOString(), muted: false, here: true, sound: null, silenced: false, forbidden: false, through_server: false, ...fields,
});
function show(call: CallView) {
  const calls = { subscribe: () => () => undefined, snapshot: () => call, sync: vi.fn(), start: vi.fn(), answer: vi.fn(), decline: vi.fn(), hangUp: vi.fn(), mute: vi.fn(), play: vi.fn(), dismiss: vi.fn() };
  state.held = { calls: calls as unknown as ChatCalls, call };
  render(<MemoryRouter><SessionQueryProvider privateSession><ChatCallLayer /></SessionQueryProvider></MemoryRouter>);
  return calls;
}
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

afterEach(() => { cleanup(); state.held = null; });

describe('a call over the page', () => {
  it('rings with the focus on no button, and Escape neither answers nor declines', () => {
    const calls = show(view({ incoming: true, state: 'ringing', here: false, answered_at: null }));
    const dialog = screen.getByRole('alertdialog', { name: 'Blair Example is calling' });
    expect(document.activeElement).toBe(dialog);
    escape();
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(calls.answer).not.toHaveBeenCalled();
    expect(calls.decline).not.toHaveBeenCalled();
    expect(document.title).toBe('Blair Example is calling');
  });

  it('Escape and "Hide" put a running call aside without hanging up, and the bar brings it back', () => {
    const calls = show(view({}));
    expect(screen.getByRole('timer', { name: 'Call time' })).toBeInTheDocument();
    escape();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the call with Blair Example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.hangUp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the call with Blair Example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    expect(calls.hangUp).toHaveBeenCalledTimes(1);
  });

  it('a call that failed before it was answered names the other person, not the relay', () => {
    show(view({ state: 'ended', ended: 'failed', answered_at: null }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Blair Example could not take the call.');
    cleanup();
    show(view({ state: 'ended', ended: 'failed' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Your administrator may need to set up the relay for calls.');
  });

  it('another tab\'s call is a line without controls', () => {
    show(view({ state: 'ended', ended: 'other-tab', here: false }));
    expect(screen.getByRole('status')).toHaveTextContent('On a call in another tab');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
