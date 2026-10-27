import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { Email, MailAccount } from '@/lib/mail-api';
import { userSettingsQueryOptions, type UserSettingValues } from '@/lib/settings-api';
import { composeBody, htmlToPlainText, responseRecipients, responseSubject } from '@/lib/compose-body';
import { useMailCompose } from '@/hooks/use-mail-compose';
import { useMailAccounts } from '@/hooks/use-mail-queries';
import { MailComposeDialog, MailComposeDialogs, MailInlineCompose } from '@/components/mail/MailCompose';
import { userSettingsAnswer } from './settings-fixtures';

const state = vi.hoisted(() => ({ toast: vi.fn(), settings: {} as Partial<UserSettingValues> }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const accounts = [
  { id: 'acc-a', email_address: 'alex@example.test', display_name: 'Alex', provider: 'custom', is_active: true, last_synced_at: null,
    signature_html: '<p>Alex <b>Example</b></p>', signature_text: 'Alex Example' },
  { id: 'acc-b', email_address: 'alex.work@example.test', display_name: 'Alex (work)', provider: 'custom', is_active: true, last_synced_at: null,
    signature_html: null, signature_text: 'Alex, Example Ltd' },
] as MailAccount[];
const received: Email = {
  id: 'email-1', mail_account_id: 'acc-a', subject: 'Quote', from_address: 'sparks@example.test', from_name: 'Sparks',
  to_addresses: ['alex@example.test', 'Bo <bo@example.test>'], cc_addresses: ['ALEX@example.test', 'cy@example.test', 'bo@example.test'],
  body_text: 'Here is the quote', body_html: null, folder: 'inbox', is_read: true, is_starred: false, received_at: '2026-10-10T08:00:00.000Z',
};

function Host() {
  const compose = useMailCompose({ activeMailAccountId: 'acc-a', selectedAccount: 'acc-a', isMobile: false });
  const loaded = useMailAccounts().data?.length ?? 0;
  const settingsLoaded = !!useQuery(userSettingsQueryOptions).data;
  return (
    <div>
      <p>{loaded} accounts{settingsLoaded ? ', settings' : ''}</p>
      <button type="button" onClick={compose.openCompose}>New message</button>
      <button type="button" onClick={() => compose.startResponse(received, 'replyAll')}>Reply all</button>
      <button type="button" onClick={() => compose.setFromAccount('acc-b')}>Send from work</button>
      <button type="button" onClick={() => compose.applyTemplate({ id: 't-1', name: 'Report', subject: 'Weekly report', body_html: '<p>Numbers attached.</p>', body_text: 'Numbers attached.', updated_at: '' })}>Use template</button>
      <MailComposeDialog compose={compose} accounts={accounts} isMobile={false} />
      <MailComposeDialogs compose={compose} />
      {compose.isReplying && <MailInlineCompose compose={compose} />}
    </div>
  );
}
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><Host /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  // Radix Select scrolls the chosen option into view; jsdom has no layout.
  Element.prototype.scrollIntoView ??= () => {};
  state.settings = {};
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/mail/accounts')) return { data: { accounts } };
    if (path === '/settings/values') return userSettingsAnswer(state.settings);
    if (path === '/mail/templates') return { data: { templates: [] } };
    return { data: { contacts: [] } };
  });
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'sent' } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('reply all', () => {
  it('writes to the sender and everyone on To and Cc, without your own address or anyone twice', () => {
    expect(responseRecipients(received, 'replyAll', 'alex@example.test')).toEqual({ to: 'sparks@example.test, Bo <bo@example.test>', cc: 'cy@example.test' });
    expect(responseRecipients(received, 'reply', 'alex@example.test')).toEqual({ to: 'sparks@example.test', cc: '' });
  });

  it('a new message without a signature starts empty, so the editor shows its placeholder', () => {
    expect(composeBody('rich', '')).toBe('');
    expect(composeBody('plain', '')).toBe('');
    expect(composeBody('rich', '<p>Sig</p>')).toBe('<p><br></p><p>Sig</p>');
  });

  it('opens a reply to all from the account that received the message', async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'Reply all' }));
    expect(await screen.findByLabelText('To')).toHaveValue('sparks@example.test, Bo <bo@example.test>');
    expect(screen.getByLabelText('Cc')).toHaveValue('cy@example.test');
  });
});

describe('response subjects', () => {
  // B-32: a reply to a reply went out as "Re: Re: …".
  it('a reply or forward adds its prefix once, also after other mail apps\' prefixes', () => {
    expect(responseSubject('reply', 'Invoice 4711')).toBe('Re: Invoice 4711');
    expect(responseSubject('replyAll', 'Re: Invoice 4711')).toBe('Re: Invoice 4711');
    expect(responseSubject('reply', 'AW: Rechnung')).toBe('AW: Rechnung');
    expect(responseSubject('forward', 'Re: Invoice 4711')).toBe('Fwd: Re: Invoice 4711');
    expect(responseSubject('forward', 'Fwd: Invoice 4711')).toBe('Fwd: Invoice 4711');
    expect(responseSubject('reply', 'Reminder: rent')).toBe('Re: Reminder: rent');
    expect(responseSubject('reply', null)).toBe('Re: ');
  });
});

describe('signatures', () => {
  // B-27: the editor writes a second line as a <div> after the first line's text.
  it('the plain-text form keeps each line of a formatted signature on its own line', () => {
    expect(htmlToPlainText('Sam Sender<div>Synthetic Testing Ltd</div>')).toBe('Sam Sender\nSynthetic Testing Ltd');
    expect(htmlToPlainText('Sam Sender<div>Synthetic Testing Ltd</div><div>+1 555 0100</div>')).toBe('Sam Sender\nSynthetic Testing Ltd\n+1 555 0100');
    expect(htmlToPlainText('<b>Sam</b> Sender<p>Synthetic Testing Ltd</p>')).toBe('Sam Sender\nSynthetic Testing Ltd');
    expect(htmlToPlainText('Sam Sender<div><br></div><div>Synthetic Testing Ltd</div>')).toBe('Sam Sender\n\nSynthetic Testing Ltd');
    // Blocks one after another are not doubled.
    expect(htmlToPlainText('<p>a</p><p>b</p>')).toBe('a\nb');
    expect(htmlToPlainText('<div>a</div><div>b</div>')).toBe('a\nb');
    expect(htmlToPlainText('Line one<br>Line two')).toBe('Line one\nLine two');
  });

  it('a new message carries the account signature, and follows the From account until something is written', async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    const editor = () => document.getElementById('compose-body')!;
    await waitFor(() => expect(editor().innerHTML).toContain('Alex <b>Example</b>'));
    fireEvent.click(screen.getByRole('combobox', { name: 'From' }));
    fireEvent.click(await screen.findByRole('option', { name: /alex\.work@example\.test/ }));
    await waitFor(() => expect(editor().innerHTML).toContain('Alex, Example Ltd'));
    expect(editor().innerHTML).not.toContain('Alex <b>Example</b>');
  });

  it('a reply puts the signature above the quoted message', async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'Reply all' }));
    await waitFor(() => expect(document.getElementById('compose-body-inline')!.innerHTML).toMatch(/Alex <b>Example<\/b>[\s\S]*<blockquote>/));
  });
});

describe('compose format', () => {
  it('in plain text the message is written and sent as plain text, with the plain signature', async () => {
    state.settings = { compose_format: 'plain' };
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    const body = await screen.findByPlaceholderText('Write your message...');
    await waitFor(() => expect(body).toHaveValue('\n\n-- \nAlex Example'));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'sparks@example.test' } });
    fireEvent.change(body, { target: { value: 'Plain hello\n\n-- \nAlex Example' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/send', expect.objectContaining({ isHtml: false, body: 'Plain hello\n\n-- \nAlex Example' }), expect.anything()));
  });

  // B-15: the failed save's toast was followed by an unhandled promise rejection.
  it('a Save draft that fails shows its error and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', record);
    try {
      vi.mocked(api.post).mockResolvedValue({ error: 'Temporary outage', status: 503 });
      state.settings = { compose_format: 'plain' };
      wrap();
      await screen.findByText('2 accounts, settings');
      fireEvent.click(screen.getByRole('button', { name: 'New message' }));
      const body = await screen.findByPlaceholderText('Write your message...');
      fireEvent.change(body, { target: { value: 'Unsaved words' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
      await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to save draft', description: 'Temporary outage' })));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('a compose link opens in the saved format once the settings have answered', async () => {
    state.settings = { compose_format: 'plain' };
    window.history.replaceState({}, '', '/mail?action=compose&to=sparks%40example.test&body=Call+me');
    wrap();
    const body = await screen.findByPlaceholderText('Write your message...');
    expect(body.tagName).toBe('TEXTAREA');
    await waitFor(() => expect(body).toHaveValue('Call me\n\n-- \nAlex Example'));
    expect(screen.getByLabelText('To')).toHaveValue('sparks@example.test');
    expect(window.location.search).toBe('');
  });

  it('a compose link waiting for slow settings does not replace a message started meanwhile', async () => {
    let answerSettings!: () => void;
    const settingsAnswered = new Promise<void>(resolve => { answerSettings = resolve; });
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/mail/accounts')) return { data: { accounts } };
      if (path === '/settings/values') { await settingsAnswered; return userSettingsAnswer(state.settings); }
      return { data: { contacts: [] } };
    });
    window.history.replaceState({}, '', '/mail?action=compose&subject=From+the+link');
    wrap();
    await screen.findByText('2 accounts');
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    fireEvent.change(await screen.findByLabelText('Subject'), { target: { value: 'My own' } });
    await act(async () => { answerSettings(); });
    await screen.findByText('2 accounts, settings');
    expect(screen.getByLabelText('Subject')).toHaveValue('My own');
    expect(window.location.search).toBe('');
  });
});

describe('templates', () => {
  it('a template fills an empty subject and starts the text above the signature', async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    await waitFor(() => expect(document.getElementById('compose-body')!.innerHTML).toContain('Alex <b>Example</b>'));
    fireEvent.click(screen.getByRole('button', { name: 'Use template', hidden: true }));
    expect(await screen.findByDisplayValue('Weekly report')).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById('compose-body')!.innerHTML).toMatch(/^<p>Numbers attached\.<\/p>[\s\S]*Alex <b>Example<\/b>/));
  });
});

// The optional compose features (P-26, layout A): off until switched on in
// Settings; then Templates and the format switch end the toolbar row and
// Send later turns Send into a split button.
// B-20: on a wide window the Attachments section sits below the message, and
// files added there could land out of view.
describe('attachments in the wide composer', () => {
  it('brings the files just added into view', async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    await screen.findByRole('dialog');
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    const input = document.getElementById('compose-attachments-dialog') as HTMLInputElement;
    const files = ['a.pdf', 'b.pdf'].map(name => new File(['synthetic'], name, { type: 'application/pdf' }));
    fireEvent.change(input, { target: { files } });
    const last = await screen.findByText('b.pdf');
    await waitFor(() => expect(scrolled.mock.contexts).toContain(last.closest('.rounded')));
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' });
  });
});

describe('optional compose features', () => {
  const optional = () => ({
    templates: screen.queryByRole('button', { name: 'Templates' }),
    format: screen.queryByRole('button', { name: /^Switch to (plain|formatted) text$/ }),
    later: screen.queryByRole('button', { name: 'Send later' }),
  });
  const openNew = async () => {
    wrap();
    await screen.findByText('2 accounts, settings');
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    await screen.findByLabelText('To');
  };
  const openMenu = (name: string) => fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false });

  it('shows no optional button until its setting is on', async () => {
    await openNew();
    expect(optional()).toEqual({ templates: null, format: null, later: null });
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('shows each switched-on feature, and Send becomes a split button', async () => {
    state.settings = { compose_templates: true, compose_format_switch: true, compose_scheduled_send: true };
    await openNew();
    const buttons = optional();
    expect(buttons.templates).toBeInTheDocument();
    expect(buttons.format).toBeInTheDocument();
    expect(buttons.later).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('switching formatted text to plain text asks first and keeps the text; back is immediate', async () => {
    state.settings = { compose_format_switch: true };
    await openNew();
    const editor = () => document.getElementById('compose-body')!;
    await waitFor(() => expect(editor().innerHTML).toContain('Alex <b>Example</b>'));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to plain text' }));
    const ask = await screen.findByRole('alertdialog');
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep formatting' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(editor()).toHaveAttribute('contenteditable', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to plain text' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Switch to plain text' }));
    const body = await screen.findByPlaceholderText('Write your message...');
    expect((body as HTMLTextAreaElement).value).toContain('Alex Example');
    expect(document.getElementById('compose-body')?.getAttribute('contenteditable')).not.toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to formatted text' }));
    await waitFor(() => expect(document.getElementById('compose-body')).toHaveAttribute('contenteditable', 'true'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Send later saves the draft first, then schedules the stored draft, closes, and Undo cancels the schedule', async () => {
    state.settings = { compose_scheduled_send: true };
    const posts: string[] = [];
    vi.mocked(api.post).mockImplementation(async (path: string, body?: unknown) => {
      posts.push(path);
      if (path === '/mail/drafts') return { data: { draft: { id: 'd-1', mail_account_id: 'acc-a', folder: 'drafts', is_draft: true, subject: (body as { subject: string }).subject,
        from_address: 'alex@example.test', to_addresses: ['sparks@example.test'], body_text: '', body_html: null, is_read: true, is_starred: false, received_at: '2026-10-23T10:00:00.000Z' }, uploaded: [] } };
      if (path === '/mail/drafts/d-1/schedule') return { data: { schedule: { email_id: 'd-1', send_at: (body as { send_at: string }).send_at, status: 'scheduled', last_error: null, created_at: '', updated_at: '' } } };
      return { error: `unexpected ${path}` };
    });
    vi.mocked(api.delete).mockResolvedValue({ data: { email_id: 'd-1', cancelled: true } });
    await openNew();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'sparks@example.test' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Minutes' } });
    const editor = document.getElementById('compose-body')!;
    await waitFor(() => expect(editor.innerHTML).toContain('Alex <b>Example</b>'));
    editor.innerHTML = `<p>See you Monday.</p>${editor.innerHTML}`;
    fireEvent.input(editor);
    openMenu('Send later');
    fireEvent.click(await screen.findByRole('menuitem', { name: /^In 1 hour/ }));
    await waitFor(() => expect(posts).toEqual(['/mail/drafts', '/mail/drafts/d-1/schedule']));
    expect(vi.mocked(api.post).mock.calls[1][1]).toEqual({ send_at: expect.any(String) });
    await waitFor(() => expect(screen.queryByLabelText('To')).not.toBeInTheDocument());
    const scheduled = state.toast.mock.calls.map(([entry]) => entry).find(entry => /^Scheduled for /.test(entry.title));
    expect(scheduled?.action).toBeTruthy();
    await act(async () => { scheduled.action.props.onClick(); });
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/mail/drafts/d-1/schedule'));
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Scheduled send cancelled' }));
  });

  it('Send later saves an edit typed while the draft was being saved before it schedules', async () => {
    state.settings = { compose_scheduled_send: true };
    const calls: string[] = [];
    let finishFirstSave!: () => void;
    const draft = (subject: string) => ({ data: { draft: { id: 'd-1', mail_account_id: 'acc-a', folder: 'drafts', is_draft: true, subject,
      from_address: 'alex@example.test', to_addresses: ['sparks@example.test'], body_text: '', body_html: null, is_read: true, is_starred: false, received_at: '2026-10-23T10:00:00.000Z' }, uploaded: [] } });
    vi.mocked(api.post).mockImplementation(async (path: string, body?: unknown) => {
      calls.push(`POST ${path}`);
      if (path === '/mail/drafts') {
        await new Promise<void>(resolve => { finishFirstSave = resolve; });
        return draft((body as { subject: string }).subject);
      }
      if (path === '/mail/drafts/d-1/schedule') return { data: { schedule: { email_id: 'd-1', send_at: (body as { send_at: string }).send_at, status: 'scheduled', last_error: null, created_at: '', updated_at: '' } } };
      return { error: `unexpected ${path}` };
    });
    vi.mocked(api.put).mockImplementation(async (path: string, body?: unknown) => {
      calls.push(`PUT ${path} ${(body as { subject: string }).subject}`);
      return draft((body as { subject: string }).subject);
    });
    await openNew();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'sparks@example.test' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Minutes' } });
    const editor = document.getElementById('compose-body')!;
    await waitFor(() => expect(editor.innerHTML).toContain('Alex <b>Example</b>'));
    editor.innerHTML = `<p>See you Monday.</p>${editor.innerHTML}`;
    fireEvent.input(editor);
    openMenu('Send later');
    fireEvent.click(await screen.findByRole('menuitem', { name: /^In 1 hour/ }));
    await waitFor(() => expect(calls).toEqual(['POST /mail/drafts']));
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Minutes, final' } });
    await act(async () => { finishFirstSave(); });
    await waitFor(() => expect(calls).toEqual(['POST /mail/drafts', 'PUT /mail/drafts/d-1 Minutes, final', 'POST /mail/drafts/d-1/schedule']));
    await waitFor(() => expect(screen.queryByLabelText('To')).not.toBeInTheDocument());
  });

  it('Send later saves a From account chosen while the draft was being saved before it schedules', async () => {
    state.settings = { compose_scheduled_send: true };
    const calls: string[] = [];
    let finishFirstSave!: () => void;
    const draft = { data: { draft: { id: 'd-1', mail_account_id: 'acc-a', folder: 'drafts', is_draft: true, subject: 'Minutes',
      from_address: 'alex@example.test', to_addresses: ['sparks@example.test'], body_text: '', body_html: null, is_read: true, is_starred: false, received_at: '2026-10-23T10:00:00.000Z' }, uploaded: [] } };
    vi.mocked(api.post).mockImplementation(async (path: string, body?: unknown) => {
      calls.push(`POST ${path}`);
      if (path === '/mail/drafts') {
        await new Promise<void>(resolve => { finishFirstSave = resolve; });
        return draft;
      }
      if (path === '/mail/drafts/d-1/schedule') return { data: { schedule: { email_id: 'd-1', send_at: (body as { send_at: string }).send_at, status: 'scheduled', last_error: null, created_at: '', updated_at: '' } } };
      return { error: `unexpected ${path}` };
    });
    vi.mocked(api.put).mockImplementation(async (path: string, body?: unknown) => {
      calls.push(`PUT ${path} ${(body as { account_id: string }).account_id}`);
      return draft;
    });
    await openNew();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'sparks@example.test' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Minutes' } });
    const editor = document.getElementById('compose-body')!;
    await waitFor(() => expect(editor.innerHTML).toContain('Alex <b>Example</b>'));
    editor.innerHTML = `<p>See you Monday.</p>${editor.innerHTML}`;
    fireEvent.input(editor);
    openMenu('Send later');
    fireEvent.click(await screen.findByRole('menuitem', { name: /^In 1 hour/ }));
    await waitFor(() => expect(calls).toEqual(['POST /mail/drafts']));
    fireEvent.click(screen.getByRole('button', { name: 'Send from work', hidden: true }));
    await act(async () => { finishFirstSave(); });
    await waitFor(() => expect(calls).toEqual(['POST /mail/drafts', 'PUT /mail/drafts/d-1 acc-b', 'POST /mail/drafts/d-1/schedule']));
  });

  it('a taken template name is refused in the dialog, which stays open', async () => {
    state.settings = { compose_templates: true };
    vi.mocked(api.post).mockResolvedValue({ error: 'A template with this name exists', status: 409, code: 'TEMPLATE_NAME_TAKEN' } as never);
    await openNew();
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Minutes' } });
    openMenu('Templates');
    expect(await screen.findByRole('menuitem', { name: 'No templates yet' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as template…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as template' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Minutes');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save template' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A template with this name exists');
    expect(api.post).toHaveBeenCalledWith('/mail/templates', expect.objectContaining({ name: 'Minutes', subject: 'Minutes' }));
    expect(screen.getByRole('dialog', { name: 'Save as template' })).toBeInTheDocument();
  });
});
