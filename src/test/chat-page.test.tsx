import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { Toaster } from '@/components/ui/toaster';
import { passphraseStrength, textParts } from '@/components/chat/chat-state';
import { WrongPassphraseError } from '@/lib/chat/key-backup';
import { useStartChat } from '@/components/chat/use-start-chat';
import type { ChatEngine } from '@/lib/chat/types';
import ChatPage from '@/pages/ChatPage';
import { createFixtureChatEngine, createMockChatEngine, message, peer } from './chat-mock-engine';

// The engine is the screens' only source; the session and the router are the real ones.
const state: { engine: ChatEngine | null } = { engine: null };
vi.mock('@/hooks/use-chat-engine', () => ({ useChatEngine: () => state.engine }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ canAccess: () => true }) }));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}{location.search}</p>;
}
function Message({ to }: { to: string }) {
  const start = useStartChat(to);
  return start && <button type="button" onClick={start}>Message</button>;
}
// The address outlives the session, as in the browser: the router is outside the part that is mounted per account.
function App({ user, at, children }: { user: string; at: string; children?: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={[at]}>
      <SessionQueryProvider key={user} privateSession>
        <Toaster />
        {children ?? <ChatPage />}
        <Where />
      </SessionQueryProvider>
    </MemoryRouter>
  );
}

const openMenu = (name: RegExp) => fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false });
const field = (name: string) => screen.getByRole('textbox', { name: `Message to ${name}` }) as HTMLTextAreaElement;

beforeEach(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }; });
afterEach(() => { cleanup(); state.engine = null; });

describe('Chat after an account switch', () => {
  it('shows nothing of the previous account: not its open chat, not a late change of its engine', () => {
    const ofA = createFixtureChatEngine();
    state.engine = ofA;
    const { rerender } = render(<App user="A" at="/chat?c=chat-blair" />);
    expect(screen.getByText('Room 2 is free until ten.', { selector: 'p' })).toBeInTheDocument();

    const ofB = createMockChatEngine({
      conversations: [{ id: 'chat-casey', peer: peer('user-casey', 'Casey Example'), unread: 0, last_activity_at: null, last_message: null }], threads: { 'chat-casey': [] },
    });
    state.engine = ofB;
    rerender(<App user="B" at="/chat?c=chat-blair" />);
    // The address still names A's chat; B's engine does not list it, so it is not opened.
    expect(screen.getByText('This chat is not available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Casey Example/ })).toBeInTheDocument();

    act(() => { ofA.send('chat-blair', 'A late message of the previous account'); });
    expect(ofA.listeners()).toBe(0);
    expect(screen.queryByText(/Blair Example|Room 2|late message/)).not.toBeInTheDocument();
    expect(ofB.calls).toEqual([]);
  });

  it('an answer to "Message" that comes after the switch opens no chat and shows no notice', async () => {
    let answer!: (id: string) => void;
    let refuse!: (error: Error) => void;
    const ofA = createFixtureChatEngine();
    ofA.openConversation = () => new Promise<string>((resolve, reject) => { answer = resolve; refuse = reject; });
    state.engine = ofA;
    const { rerender } = render(<App user="A" at="/contacts"><Message to="user-blair" /></App>);
    fireEvent.click(screen.getByRole('button', { name: 'Message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Message' }));
    const first = answer;

    state.engine = createMockChatEngine();
    rerender(<App user="B" at="/contacts"><Message to="user-blair" /></App>);
    await act(async () => { first('chat-blair'); refuse(new Error('Blair Example cannot be written to.')); await new Promise(done => setTimeout(done, 20)); });
    expect(screen.getByTestId('where')).toHaveTextContent('/contacts');
    expect(screen.queryByText(/cannot be written to|Could not open/)).not.toBeInTheDocument();
  });
});

describe('Chat composer and message menu', () => {
  it('Enter sends and keeps the focus, Shift+Enter does not; a draft waits while another chat is open', () => {
    const engine = createFixtureChatEngine();
    state.engine = engine;
    render(<App user="A" at="/chat?c=chat-alex" />);
    const input = field('Alex Example');
    input.focus();
    fireEvent.change(input, { target: { value: 'First line' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(engine.calls).toEqual([]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(engine.calls).toEqual([['send', 'chat-alex', 'First line', null]]);
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.getByText('Sending…')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Not sent yet' } });
    fireEvent.click(screen.getByRole('link', { name: /Blair Example/ }));
    // Opening a chat with unread messages, with the page in front, marks them read.
    expect(engine.calls).toContainEqual(['markRead', 'chat-blair']);
    expect(field('Blair Example')).toHaveValue('');
    fireEvent.click(screen.getByRole('link', { name: /Alex Example/ }));
    expect(field('Alex Example')).toHaveValue('Not sent yet');
  });

  it('Reply and Edit move the focus to the composer, Escape leaves them, and a deleted message hands the focus on', async () => {
    const engine = createFixtureChatEngine();
    state.engine = engine;
    render(<App user="A" at="/chat?c=chat-alex" />);
    const input = field('Alex Example');
    fireEvent.change(input, { target: { value: 'A draft' } });

    openMenu(/the message from Alex Example/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reply' }));
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByText('Replying to Alex Example')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('Replying to Alex Example')).not.toBeInTheDocument();
    expect(input).toHaveFocus();

    openMenu(/your message/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue('I will send the numbers tomorrow.');
    // The unchanged text is nothing to save.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(engine.calls.filter(([name]) => name === 'edit')).toEqual([]);
    fireEvent.change(input, { target: { value: 'I will send the numbers on Tuesday.' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(engine.calls).toContainEqual(['edit', 'a2', 'I will send the numbers on Tuesday.']);
    expect(screen.getByText('Saving the change…')).toBeInTheDocument();
    // The draft the edit borrowed the field from is back.
    await waitFor(() => expect(input).toHaveValue('A draft'));

    openMenu(/your message/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this message?' })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Message deleted', { selector: 'li p' })).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('a refused delete says why in the server\'s words and keeps the message', async () => {
    const reason = 'Your administrator does not allow deleting items from the bin for good.';
    state.engine = createMockChatEngine({
      conversations: [{ id: 'chat-alex', peer: peer('user-alex', 'Alex Example'), unread: 0, last_activity_at: null, last_message: null }],
      threads: { 'chat-alex': [message('a2', true, 'Ada Example', '2026-06-14T16:12:00.000Z', 'Kept by the rule')] }, deleteRefusal: reason,
    });
    render(<App user="A" at="/chat?c=chat-alex" />);
    openMenu(/your message/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.getByText('Kept by the rule')).toBeInTheDocument();
  });
});

describe('Chat small print of a message', () => {
  it('discards a message that was never sent without asking, names oneself "You" in a quote, and leaves an edit the engine refuses', async () => {
    const engine = createFixtureChatEngine();
    engine.edit = () => { throw new Error('Only your own messages can be edited.'); };
    state.engine = engine;
    render(<App user="A" at="/chat?c=chat-blair" />);
    // Blair's answer quotes Ada's message; Ada reads "You", Blair's name stays in Ada's own quote of Blair.
    const quote = (text: string) => screen.getByText(text, { selector: 'span' }).previousElementSibling;
    expect(quote('Yes. They confirmed Thursday for the first batch.')).toHaveTextContent(/^You$/);
    expect(quote('Sorry, new phone. The plan is here: https://intranet.example.com/rota/june')).toHaveTextContent('Blair Example');
    // Still on its way: nothing to do with it. Failed: it can be thrown away.
    expect(screen.queryByRole('button', { name: /your message at 09:27/ })).not.toBeInTheDocument();
    expect(screen.getByText('Not sent. No connection to the server.')).toBeInTheDocument();
    openMenu(/your message at 09:28/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Discard' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(engine.calls).toContainEqual(['delete', 'm10']));

    openMenu(/your message at 09:05/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const input = field('Blair Example');
    fireEvent.change(input, { target: { value: 'Agenda: rota and holidays.' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Only your own messages can be edited.')).toBeInTheDocument();
    expect(screen.queryByText('Editing your message')).not.toBeInTheDocument();
  });

  it('gives a message of a person who cannot be written to no menu', () => {
    state.engine = createFixtureChatEngine();
    render(<App user="A" at="/chat?c=chat-katherine" />);
    expect(screen.getByText(/year-end close/, { selector: 'li p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
  });
});

describe('the chat passphrase', () => {
  const blair = [{ id: 'chat-blair', peer: peer('user-blair', 'Blair Example'), unread: 1, last_activity_at: null, last_message: null }];
  const passphraseField = () => screen.getByLabelText('Chat passphrase');

  it('keeps a wrong passphrase on the prompt, opens the chats with "Not now" and brings the prompt back from their line', async () => {
    const engine = createMockChatEngine({ readiness: { state: 'enter-passphrase' }, conversations: blair, threads: { 'chat-blair': [] } });
    const real = engine.enterPassphrase;
    engine.enterPassphrase = passphrase => passphrase === 'four unrelated words here' ? real(passphrase) : Promise.reject(new WrongPassphraseError());
    state.engine = engine;
    render(<App user="A" at="/chat" />);
    fireEvent.change(passphraseField(), { target: { value: 'not the passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get my earlier messages' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This is not your chat passphrase.');
    expect(screen.queryByRole('list', { name: 'Chats' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.getByRole('link', { name: /Blair Example/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enter passphrase' }));
    fireEvent.change(passphraseField(), { target: { value: 'four unrelated words here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get my earlier messages' }));
    expect(await screen.findByRole('link', { name: /Blair Example/ })).toBeInTheDocument();
    expect(screen.queryByText('Your earlier messages are not on this device yet.')).not.toBeInTheDocument();
  });

  it('starts a new key with the account password and the new passphrase, and never sends the one typed behind the dialog', async () => {
    const engine = createMockChatEngine({ readiness: { state: 'enter-passphrase' }, conversations: blair, threads: { 'chat-blair': [] } });
    state.engine = engine;
    render(<App user="A" at="/chat" />);
    fireEvent.change(passphraseField(), { target: { value: 'half remembered' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start a new key…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Start a new key?' }));
    expect(dialog.getByText(/cannot be read again/)).toBeInTheDocument();
    const start = dialog.getByRole('button', { name: 'Start a new key' });
    fireEvent.change(dialog.getByLabelText('Chat passphrase'), { target: { value: 'a brand new passphrase' } });
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'account-password' } });
    // The repeat is missing: nothing can be started yet.
    expect(start).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Repeat the passphrase'), { target: { value: 'a brand new passphrase' } });
    fireEvent.click(start);
    await waitFor(() => expect(engine.calls).toEqual([['startNewKey', 'account-password', 'a brand new passphrase']]));
    expect(await screen.findByRole('link', { name: /Blair Example/ })).toBeInTheDocument();
  });

  it('hints at the strength without calling a short or repetitive passphrase good', () => {
    expect(passphraseStrength('')).toEqual({ level: 0, hint: 'At least 12 characters' });
    expect(passphraseStrength('elevenchars')).toEqual({ level: 0, hint: '1 more character' });
    expect(passphraseStrength('aaaaaaaaaaaaaaaaaaaaaaaa').level).toBe(1);
    expect(passphraseStrength('lowercaseonly').level).toBe(1);
    expect(passphraseStrength('correct horse battery').level).toBe(3);
    expect(passphraseStrength('Tuesday-rota42').level).toBe(2);
  });
});

describe('message text', () => {
  it('links web addresses only', () => {
    expect(textParts('See https://intranet.example.com/rota/june. Not javascript:alert(1) or data:text/html,x')).toEqual([
      { text: 'See ' }, { text: 'https://intranet.example.com/rota/june', href: 'https://intranet.example.com/rota/june' }, { text: '. Not javascript:alert(1) or data:text/html,x' },
    ]);
    expect(textParts('https://example.com')).toEqual([{ text: 'https://example.com', href: 'https://example.com' }]);
  });
});
