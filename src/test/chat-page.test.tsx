import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { Toaster } from '@/components/ui/toaster';
import { ChatApprovalDialog } from '@/components/chat/ChatApprovalDialog';
import { passphraseStrength, textParts } from '@/components/chat/chat-state';
import { WrongPassphraseError } from '@/lib/chat/key-backup';
import { useStartChat } from '@/components/chat/use-start-chat';
import type { ChatEngine } from '@/lib/chat/types';
import ChatPage from '@/pages/ChatPage';
import { saveFile } from '@/lib/platform';
import { CHAT_CANDIDATES, CHAT_CONVERSATIONS, CHAT_THREADS, createFixtureChatEngine, createMockChatEngine, direct, message, peer } from './chat-mock-engine';

// The engine is the screens' only source; the session and the router are the real ones.
const state: { engine: ChatEngine | null } = { engine: null };
vi.mock('@/hooks/use-chat-engine', () => ({ useChatEngine: () => state.engine }));
vi.mock('@/hooks/use-chat-calls', () => ({ useChatCalls: () => null }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ canAccess: () => true }) }));
vi.mock('@/lib/platform', async original => ({ ...await original<typeof import('@/lib/platform')>(), saveFile: vi.fn(async () => undefined) }));

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
const field = (name: string) => screen.getByLabelText(`Message to ${name}`) as HTMLTextAreaElement;

beforeEach(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }; });
afterEach(() => { cleanup(); state.engine = null; });

describe('Chat after an account switch', () => {
  it('shows nothing of the previous account: not its open chat, not a late change of its engine', () => {
    const ofA = createFixtureChatEngine();
    state.engine = ofA;
    const { rerender } = render(<App user="A" at="/chat?c=chat-blair" />);
    expect(screen.getByText('Room 2 is free until ten.', { selector: 'p' })).toBeInTheDocument();

    const ofB = createMockChatEngine({
      conversations: [direct({ id: 'chat-casey', peer: peer('user-casey', 'Casey Example'), unread: 0, last_activity_at: null, last_message: null })], threads: { 'chat-casey': [] },
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
      conversations: [direct({ id: 'chat-alex', peer: peer('user-alex', 'Alex Example'), unread: 0, last_activity_at: null, last_message: null })],
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

describe('a device asks to join the chats', () => {
  it('approves the request with the code the person read, and says so when that request has ended', async () => {
    const engine = createMockChatEngine({ approveRefusal: 'That request has ended. Ask again on the other device.',
      approvals: [{ chat_device_id: 'chat-dev-new', device: { id: 'dev-new', kind: 'web', app_version: null, user_agent: null }, requested_at: new Date().toISOString(), code: '481516', signed_in_at: null }] });
    state.engine = engine;
    render(<App user="A" at="/mail"><ChatApprovalDialog /></App>);
    const dialog = await screen.findByRole('dialog', { name: 'A device asks to join your chats' });
    // The focus is on the dialog, not on a button: Enter approves nothing.
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByText('Code: 4 8 1 5 1 6')).toBeInTheDocument();
    expect(within(dialog).getByText(/When it signed in is not known\./)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText('That request has ended. Ask again on the other device.')).toHaveAttribute('role', 'alert');
    expect(engine.calls).toEqual([['approve', 'chat-dev-new', '481516']]);
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the chat passphrase', () => {
  const blair = [direct({ id: 'chat-blair', peer: peer('user-blair', 'Blair Example'), unread: 1, last_activity_at: null, last_message: null })];
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

describe('group chats', () => {
  const sent = (engine: { calls: unknown[][] }) => engine.calls.filter(([name]) => name === 'send');

  it('"@" offers the chat\'s people: the arrows choose, Enter takes one instead of sending, Escape closes the list, and the message names who it mentions', () => {
    const engine = createFixtureChatEngine();
    state.engine = engine;
    render(<App user="A" at="/chat?c=chat-planning" />);
    const input = field('Warehouse planning');
    input.focus();
    fireEvent.change(input, { target: { value: 'Thanks @c' } });
    // Only active people whose name has the letters; the deactivated one is not offered.
    expect(within(screen.getByRole('listbox', { name: 'People to mention' })).getAllByRole('option').map(option => option.textContent)).toEqual(['Casey Example', 'Katherine Johnson-Example of the Accounting Office']);
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    // Shift+Enter stays a new line: it takes nobody from the list.
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(input).toHaveValue('Thanks @c');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /^Katherine/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('Thanks @Casey Example ');
    expect(input).toHaveFocus();
    expect(sent(engine)).toEqual([]);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Thanks @Casey Example and @bl' } });
    expect(screen.getByRole('option', { name: 'Blair Example' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // Closed for this "@" only: a new one in its place offers again.
    fireEvent.change(input, { target: { value: 'Thanks @Casey Example and ' } });
    fireEvent.change(input, { target: { value: 'Thanks @Casey Example and @bl' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent(engine)).toEqual([['send', 'chat-planning', 'Thanks @Casey Example and @bl', null, ['user-casey']]]);
  });

  it('removing someone hands the focus to the people panel, since their row is gone; Cancel and closing the panel hand it back to their buttons', async () => {
    const engine = createFixtureChatEngine();
    state.engine = engine;
    render(<App user="A" at="/chat?c=chat-planning" />);
    const people = screen.getByRole('button', { name: 'People in this chat' });
    people.focus();
    fireEvent.click(people);
    const panel = screen.getByRole('dialog', { name: 'Warehouse planning' });
    const remove = (name: string) => { const button = within(panel).getByRole('button', { name: `Remove ${name}`, hidden: true }); button.focus(); fireEvent.click(button); return button; };
    const kept = remove('Alex Example');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(kept).toHaveFocus());
    remove('Casey Example');
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Remove Casey Example from Warehouse planning?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(panel).toHaveFocus());
    expect(engine.calls).toContainEqual(['removeMember', 'chat-planning', 'user-casey']);
    expect(within(panel).queryByRole('button', { name: 'Remove Casey Example' })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(people).toHaveFocus());
  });

  it('the people panel shows the name the chat has when it opens, and says what adding someone under a shorter retention does', async () => {
    const engine = createFixtureChatEngine({
      conversations: CHAT_CONVERSATIONS.map(chat => (chat.id === 'chat-planning' ? { ...chat, retention_days: 90 as const } : chat)),
      candidates: { ...CHAT_CANDIDATES, people: [{ id: 'user-finley', email: 'finley@example.com', full_name: 'Finley Example', retention_days: 30 }, { id: 'user-gale', email: 'gale@example.com', full_name: 'Gale Example', retention_days: 365 }] },
    });
    state.engine = engine;
    render(<App user="A" at="/chat?c=chat-planning" />);
    fireEvent.click(screen.getByRole('button', { name: 'People in this chat' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Typed and left' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Warehouse planning' })).getByRole('button', { name: 'Close' }));
    // Renamed by someone else meanwhile.
    await act(async () => { await engine.rename('chat-planning', 'Warehouse plans'); });
    fireEvent.click(screen.getByRole('button', { name: 'People in this chat' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Warehouse plans');

    fireEvent.click(screen.getByRole('button', { name: 'Add people' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Add people to Warehouse plans' }));
    // A year is longer than the chat's 90 days: nothing changes for the chat.
    fireEvent.click(await dialog.findByRole('checkbox', { name: /^Gale Example/ }));
    expect(dialog.queryByText(/for everyone/)).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('checkbox', { name: /^Finley Example/ }));
    expect(dialog.getByText(/it will delete messages older than 30 days for everyone, starting 24 hours after they are added/)).toHaveTextContent(/^For Finley Example, chat messages are deleted after 30 days\./);
  });

  const leaveChat = () => {
    fireEvent.click(screen.getByRole('button', { name: 'People in this chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave chat' }));
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Leave Warehouse planning?' })).getByRole('button', { name: 'Leave chat' }));
  };

  it('leaving a chat goes back to the list', async () => {
    state.engine = createFixtureChatEngine();
    render(<App user="A" at="/chat?c=chat-planning" />);
    leaveChat();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/chat$/));
    expect(screen.queryByRole('link', { name: /^Warehouse planning/ })).not.toBeInTheDocument();
  });

  it('a chat left while another one was opened meanwhile moves nothing there', async () => {
    const engine = createFixtureChatEngine();
    const leave = engine.leave;
    let answer!: () => void;
    engine.leave = id => new Promise<void>(resolve => { answer = () => resolve(leave(id)); });
    state.engine = engine;
    render(<App user="A" at="/chat?c=chat-planning" />);
    leaveChat();
    fireEvent.click(screen.getByRole('link', { name: /^Alex Example/, hidden: true }));
    await act(async () => { answer(); await new Promise(done => setTimeout(done, 20)); });
    expect(screen.getByTestId('where')).toHaveTextContent('/chat?c=chat-alex');
    expect(field('Alex Example')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Warehouse planning/ })).not.toBeInTheDocument();
  });

  it('a new group chat the server refuses keeps the dialog with its name and ticked people, and says why in the server\'s words', async () => {
    const engine = createFixtureChatEngine();
    engine.createGroup = async () => { throw new Error('A chat can have at most 100 people.'); };
    state.engine = engine;
    render(<App user="A" at="/chat" />);
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    const dialog = within(screen.getByRole('dialog', { name: 'New group chat' }));
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Stocktake' } });
    fireEvent.click(await dialog.findByRole('checkbox', { name: /^Blair Example/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'Create chat' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('A chat can have at most 100 people.');
    expect(dialog.getByLabelText('Name')).toHaveValue('Stocktake');
    expect(dialog.getByRole('checkbox', { name: /^Blair Example/ })).toBeChecked();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/chat$/);
  });

  it('offers to load the people again when they do not come', () => {
    vi.useFakeTimers();
    try {
      const engine = createFixtureChatEngine({ members: {} });
      const asked = vi.spyOn(engine, 'members');
      state.engine = engine;
      render(<App user="A" at="/chat?c=chat-planning" />);
      fireEvent.click(screen.getByRole('button', { name: 'People in this chat' }));
      expect(screen.getByText('Loading the people…')).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(8000); });
      expect(screen.getByText('Could not load the people')).toBeInTheDocument();
      asked.mockClear();
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      expect(asked).toHaveBeenCalledWith('chat-planning');
      expect(screen.getByText('Loading the people…')).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
});

describe('files, voice messages and search', () => {
  const picture = (name: string) => new File(['picture'], name, { type: 'image/png' });
  const sends = (engine: { calls: unknown[][] }) => engine.calls.filter(([name]) => name === 'send');
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:shown');
    URL.revokeObjectURL = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(saveFile).mockClear();
  });

  it('files wait above the field until the message is sent: picked, pasted and dropped, removed one by one, ten at most', () => {
    const engine = createFixtureChatEngine();
    state.engine = engine;
    render(<App user="A" at="/chat?c=chat-alex" />);
    const names = () => within(screen.getByRole('list', { name: 'Files to send' })).getAllByRole('listitem').map(item => item.querySelector('span span')!.textContent);
    const pick = (files: File[]) => fireEvent.change(screen.getByLabelText('Choose files to send'), { target: { files } });
    pick([picture('one.png'), new File(['abc'], 'notes.txt', { type: 'text/plain' })]);
    fireEvent.paste(field('Alex Example'), { clipboardData: { files: [picture('pasted.png')], types: ['Files'], getData: () => '' } });
    // Cells copied from a spreadsheet come with a picture of themselves: they stay text, for the field to take.
    expect(fireEvent.paste(field('Alex Example'), { clipboardData: { files: [picture('cells.png')], types: ['text/html', 'text/plain', 'Files'], getData: () => '12\t34' } })).toBe(true);
    fireEvent.drop(screen.getByRole('region', { name: 'Chat with Alex Example' }), { dataTransfer: { files: [picture('dropped.png')], types: ['Files'] } });
    expect(names()).toEqual(['one.png', 'notes.txt', 'pasted.png', 'dropped.png']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(names()).toEqual(['one.png', 'pasted.png', 'dropped.png']);

    pick(Array.from({ length: 8 }, (_, index) => picture(`more-${index}.png`)));
    expect(names()).toHaveLength(10);
    expect(screen.getByText('A message has at most 10 files.')).toBeInTheDocument();
    expect(sends(engine)).toEqual([]);

    // Files alone are a message: no text is needed.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const [[, chat, text, reply, mentions, files]] = sends(engine) as [[string, string, string, null, string[], { name: string }[]]];
    expect([chat, text, reply, mentions]).toEqual(['chat-alex', '', null, []]);
    expect(files.map(file => file.name)).toEqual(['one.png', 'pasted.png', 'dropped.png', ...Array.from({ length: 7 }, (_, index) => `more-${index}.png`)]);
    expect(screen.queryByRole('list', { name: 'Files to send' })).not.toBeInTheDocument();
    expect(screen.queryByText('A message has at most 10 files.')).not.toBeInTheDocument();
  });

  it('the recorder waits for the microphone, counts, discards and sends; ten minutes end it as a file to send; a refused microphone says so', async () => {
    const stopped = vi.fn();
    class Recorder {
      static isTypeSupported = (type: string) => type.startsWith('audio/webm');
      state = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['sound']) }); this.onstop?.(); }
    }
    let allow!: () => void;
    const getUserMedia = vi.fn(() => new Promise((resolve, reject) => { allow = () => resolve({ getTracks: () => [{ stop: stopped }] }); void reject; }));
    vi.stubGlobal('MediaRecorder', Recorder);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.useFakeTimers();
    try {
      const engine = createFixtureChatEngine();
      state.engine = engine;
      render(<App user="A" at="/chat?c=chat-alex" />);
      const record = async () => { fireEvent.click(screen.getByRole('button', { name: 'Record a voice message' })); };
      const pass = (seconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(seconds * 1000); });

      await record();
      expect(screen.getByText('Waiting for the microphone…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send the voice message' })).toBeDisabled();
      await act(async () => { allow(); });
      await pass(3);
      expect(screen.getByRole('timer')).toHaveTextContent('0:03');
      fireEvent.click(screen.getByRole('button', { name: 'Discard the recording' }));
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(field('Alex Example')).toHaveFocus();
      expect(sends(engine)).toEqual([]);

      await record();
      await act(async () => { allow(); });
      await pass(5);
      fireEvent.click(screen.getByRole('button', { name: 'Send the voice message' }));
      expect(sends(engine)).toEqual([['send', 'chat-alex', '', null, [], [{ blob: expect.any(Blob), name: 'Voice message.webm', voice_seconds: 5 }]]]);
      expect(screen.queryByRole('list', { name: 'Files to send' })).not.toBeInTheDocument();

      // Nobody pressed Send: the recording that ended by itself is not sent by itself.
      await record();
      await act(async () => { allow(); });
      await pass(601);
      expect(within(screen.getByRole('list', { name: 'Files to send' })).getByRole('listitem')).toHaveTextContent('Voice message.webm10:00');
      expect(screen.getByText(/The recording stopped at 10 minutes/)).toBeInTheDocument();
      expect(sends(engine)).toHaveLength(1);

      getUserMedia.mockImplementationOnce(() => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')));
      await record();
      await act(async () => {});
      expect(screen.getByText(/UniHub may not use the microphone\. Allow the microphone for this site/)).toBeInTheDocument();
      expect(field('Alex Example')).toBeInTheDocument();
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it('a file that arrives after its chat was left is not saved, a picture\'s address is given back, and a deleted message closes its picture', async () => {
    let answer!: (blob: Blob) => void;
    const sheet = new Blob(['rows']);
    const engine = createFixtureChatEngine({ files: { 'file-stock': () => new Promise<Blob>(resolve => { answer = resolve; }), 'file-gate': () => new Promise<Blob>(() => {}) } });
    state.engine = engine;
    render(<App user="A" at="/chat?c=chat-finley" />);
    const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save Stock list June.xlsx' }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    save();
    expect(screen.getByText('Getting it… 0%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /^Blair Example/ }));
    await act(async () => { answer(sheet); });
    expect(saveFile).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:shown');

    // The same file asked for in its chat is saved under its name.
    fireEvent.click(screen.getByRole('link', { name: /^Finley Example/ }));
    save();
    await act(async () => { answer(sheet); });
    expect(saveFile).toHaveBeenCalledWith(sheet, 'Stock list June.xlsx');

    fireEvent.click(screen.getByRole('button', { name: 'Open the picture Gate 13 June.jpg' }));
    expect(screen.getByRole('dialog', { name: 'Gate 13 June.jpg' })).toHaveTextContent('Getting the file…');
    await act(async () => { await engine.delete('f1'); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('search puts what it finds in place of the chats, the arrows move between the field and the results, Escape brings the chats back, and a message opens its chat there', async () => {
    const old = Array.from({ length: 250 }, (_, index) => message(`o${index}`, false, 'Blair Example', new Date(Date.UTC(2026, 4, 1, 8, index)).toISOString(), index === 3 ? 'The forklift licence is renewed.' : `Line ${index}`));
    state.engine = createFixtureChatEngine({ threads: { ...CHAT_THREADS, 'chat-blair': old } });
    render(<App user="A" at="/chat" />);
    const search = screen.getByRole('searchbox', { name: 'Search chats and messages' });
    search.focus();
    fireEvent.change(search, { target: { value: 'plan' } });
    const results = within(await screen.findByRole('region', { name: 'Search results' }));
    expect(screen.queryByRole('list', { name: 'Chats' })).not.toBeInTheDocument();
    const [chat, first] = results.getAllByRole('link');
    expect(chat).toHaveTextContent('Warehouse planning');
    expect(results.getByText('Search looks through the chats on this device. The server cannot read them.')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(chat).toHaveFocus();
    fireEvent.keyDown(chat, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    fireEvent.keyDown(chat, { key: 'ArrowUp' });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('list', { name: 'Chats' })).toBeInTheDocument();

    // A file's name is found like a text.
    fireEvent.change(search, { target: { value: 'xlsx' } });
    expect(await screen.findByRole('link', { name: /Finley Example.*Stock list June\.xlsx/ })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'FORKLIFT' } });
    const hit = await screen.findByRole('link', { name: /forklift/ });
    expect(within(hit).getByText('forklift').tagName).toBe('MARK');
    fireEvent.click(hit);
    expect(screen.getByTestId('where')).toHaveTextContent('/chat?c=chat-blair&m=o3');
    // The message is older than the 200 a chat draws at first: the earlier ones are drawn as far back as it.
    const found = await screen.findByText('The forklift licence is renewed.', { selector: 'ol p' });
    await waitFor(() => expect((Element.prototype.scrollIntoView as Mock).mock.contexts.at(-1)).toBe(found.closest('li')));
  }, 20_000);
});

describe('message text', () => {
  it('marks "@name" for the people a message mentions, the longest name first', () => {
    const [alex, alexander] = [{ name: 'Alex' }, { name: 'Alex Example' }];
    expect(textParts('@Alex Example and @Alex, not @Alexa or mail@Alex.example', [alex, alexander])).toEqual([
      { text: '@Alex Example', mention: alexander }, { text: ' and ' }, { text: '@Alex', mention: alex }, { text: ', not @Alexa or mail' }, { text: '@Alex' }, { text: '.example' },
    ]);
  });

  it('links web addresses only', () => {
    expect(textParts('See https://intranet.example.com/rota/june. Not javascript:alert(1) or data:text/html,x')).toEqual([
      { text: 'See ' }, { text: 'https://intranet.example.com/rota/june', href: 'https://intranet.example.com/rota/june' }, { text: '. Not javascript:alert(1) or data:text/html,x' },
    ]);
    expect(textParts('https://example.com')).toEqual([{ text: 'https://example.com', href: 'https://example.com' }]);
  });
});
