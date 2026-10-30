import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { Email, MailAccount } from '@/lib/mail-api';
import { useMailCompose } from '@/hooks/use-mail-compose';
import { MailComposeDialog } from '@/components/mail/MailCompose';
import { trackVisibleArea } from '@/lib/visible-area';
import { userSettingsAnswer } from './settings-fixtures';

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const accounts = [
  { id: 'acc-a', email_address: 'alex@example.test', display_name: 'Alex', provider: 'custom', is_active: true, last_synced_at: null },
  { id: 'acc-b', email_address: 'alex.work@example.test', display_name: 'Alex (work)', provider: 'custom', is_active: true, last_synced_at: null },
] as MailAccount[];
const draft: Email = {
  id: 'draft-1', mail_account_id: 'acc-a', subject: 'Plan', from_address: 'alex@example.test', from_name: 'Alex', folder: 'drafts', is_draft: true,
  to_addresses: ['Jane Doe <jane@example.com>', 'sam@example.org'], cc_addresses: ['copy@example.test'], bcc_addresses: [],
  body_text: null, body_html: '<p>Draft</p>', is_read: true, is_starred: false, received_at: '2026-10-10T08:00:00.000Z',
};

/** The Mail page on a phone: the composer is the full-screen dialog. */
function Host() {
  const compose = useMailCompose({ activeMailAccountId: 'acc-a', selectedAccount: 'acc-a', isMobile: true });
  return (
    <div>
      <button type="button" onClick={compose.openCompose}>New message</button>
      <button type="button" onClick={() => compose.openDraftForCompose(draft)}>Open draft</button>
      <MailComposeDialog compose={compose} accounts={accounts} isMobile />
    </div>
  );
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><Host /></MemoryRouter></QueryClientProvider>);
}
const chips = () => within(screen.getByRole('list', { name: 'To recipients' })).getAllByRole('button').map(chip => chip.getAttribute('aria-label'));

beforeEach(() => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/mail/accounts')) return { data: { accounts } };
    if (path === '/settings/values') return userSettingsAnswer({});
    return { data: { contacts: [{ id: 'c-1', display_name: 'Sparks', emails: [{ value: 'sparks@example.test', preferred: false }] }] } };
  });
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'sent' } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the phone composer (0.25.0)', () => {
  // The first test pays the cold render of the dialog; under load that alone can take seconds.
  it('turns a typed address into a chip on comma, Enter and leaving the field, and sends them all', { timeout: 15_000 }, async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    const to = await screen.findByLabelText('To');
    fireEvent.change(to, { target: { value: 'first@example.com,' } });
    expect(chips()).toEqual(['first@example.com']);
    expect(to).toHaveValue('');
    fireEvent.change(to, { target: { value: 'second@example.com' } });
    fireEvent.keyDown(to, { key: 'Enter' });
    expect(chips()).toEqual(['first@example.com', 'second@example.com']);
    fireEvent.change(to, { target: { value: 'third@example.com' } });
    fireEvent.blur(to);
    expect(chips()).toEqual(['first@example.com', 'second@example.com', 'third@example.com']);
    // A pick from the contact list becomes a chip with the contact's name.
    fireEvent.focus(to);
    fireEvent.change(to, { target: { value: 'spa' } });
    fireEvent.mouseDown(await screen.findByRole('button', { name: /Sparks/ }));
    expect(chips()).toEqual(['first@example.com', 'second@example.com', 'third@example.com', 'Sparks <sparks@example.test>']);
    expect(within(screen.getByRole('list', { name: 'To recipients' })).getByRole('button', { name: 'Sparks <sparks@example.test>' })).toHaveTextContent('Sparks');

    const editor = document.getElementById('compose-body')!;
    editor.innerHTML = '<p>Hello</p>';
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/send', expect.objectContaining({
      to: expect.stringMatching(/^first@example\.com, second@example\.com, third@example\.com, Sparks <sparks@example\.test>,? ?$/),
    }), expect.anything()));
  });

  it('removes a chip from its menu, and Backspace in the empty field takes the last chip back to edit', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    const to = await screen.findByLabelText('To');
    fireEvent.change(to, { target: { value: 'first@example.com, second@example.com, nonsense,' } });
    expect(chips()).toEqual(['first@example.com', 'second@example.com', 'nonsense, not an email address']);
    fireEvent.keyDown(to, { key: 'Backspace' });
    expect(to).toHaveValue('nonsense');
    expect(chips()).toEqual(['first@example.com', 'second@example.com']);
    fireEvent.change(to, { target: { value: '' } });
    // Delete on a focused chip removes it; the others stay.
    const first = within(screen.getByRole('list', { name: 'To recipients' })).getByRole('button', { name: 'first@example.com' });
    fireEvent.keyDown(first, { key: 'Delete' });
    expect(chips()).toEqual(['second@example.com']);
  });

  it('shows Cc/Bcc and From as one line that opens into rows, open from the start for a draft with a Cc', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    await screen.findByLabelText('To');
    expect(screen.queryByLabelText('Cc')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'From' })).toBeNull();
    const line = screen.getByRole('button', { name: /^Cc\/Bcc, From:/ });
    expect(line).toHaveTextContent('alex@example.test');
    fireEvent.click(line);
    expect(screen.getByLabelText('Cc')).toHaveFocus();
    expect(screen.getByLabelText('Bcc')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'From' })).toHaveTextContent('alex@example.test');
    expect(screen.queryByRole('button', { name: /^Cc\/Bcc, From:/ })).toBeNull();
    cleanup();

    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open draft' }));
    await screen.findByLabelText('Cc');
    expect(screen.queryByRole('button', { name: /^Cc\/Bcc, From:/ })).toBeNull();
    expect(chips()).toEqual(['Jane Doe <jane@example.com>', 'sam@example.org']);
    expect(within(screen.getByRole('list', { name: 'Cc recipients' })).getAllByRole('button').map(chip => chip.getAttribute('aria-label'))).toEqual(['copy@example.test']);
    // Saved again, the draft keeps exactly these recipients.
    vi.mocked(api.put).mockResolvedValue({ data: { draft } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/drafts/draft-1', expect.objectContaining({
      to: 'Jane Doe <jane@example.com>, sam@example.org', cc: 'copy@example.test', bcc: '',
    })));
  });
});

describe('the visible area above the keyboard', () => {
  it('follows the visual viewport while it is not pinch-zoomed', () => {
    const listeners: Record<string, () => void> = {};
    const viewport = { height: 915, offsetTop: 0, scale: 1,
      addEventListener: (type: string, listener: () => void) => { listeners[type] = listener; }, removeEventListener: () => {} };
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    const stop = trackVisibleArea();
    expect(document.documentElement.style.getPropertyValue('--visible-height')).toBe('915px');
    viewport.height = 560.4; viewport.offsetTop = 0;
    act(() => listeners.resize());
    expect(document.documentElement.style.getPropertyValue('--visible-height')).toBe('560px');
    viewport.scale = 2;
    act(() => listeners.resize());
    expect(document.documentElement.style.getPropertyValue('--visible-height')).toBe('');
    stop();
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
  });
});
