import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { MailAccount, MailFolder } from '@/lib/mail-api';
import type { MailTemplate } from '@/lib/mail-essentials-api';
import { DEFAULT_CALENDAR_SETTINGS, DEFAULT_MAIL_ACCOUNT_SETTINGS, defaultsResolved, type MailAccountSettingValues, type UserSettings } from '@/lib/settings-api';
import GeneralSettings from '@/components/settings/GeneralSettings';
import MailSettings from '@/components/settings/MailSettings';
import { NotificationChoices } from '@/components/settings/NotificationChoices';
import { folderRef, toggleFolder } from '@/lib/notification-folders';
import { savedSettingsAnswer, userSettingsAnswer } from './settings-fixtures';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, modules: [], pages: [] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const accounts = [
  { id: 'acc-a', email_address: 'alex@example.test', display_name: 'Alex', provider: 'custom', is_active: true, last_synced_at: null, signature_html: '<p>Alex <b>Example</b></p>', signature_text: 'Alex Example' },
  { id: 'acc-b', email_address: 'bo@example.test', display_name: null, provider: 'custom', is_active: true, last_synced_at: null, signature_html: null, signature_text: null },
] as MailAccount[];
const RECEIPTS_ID = '6f1c2a4e-9b1d-4c3a-8e5f-1a2b3c4d5e6f';
const folders: MailFolder[] = [
  { id: 'f-inbox', slug: 'inbox', display_name: 'Inbox', is_system: true, position: 0, roles: ['inbox'] },
  { id: 'f-junk', slug: 'junk', display_name: 'Junk', is_system: true, position: 1, roles: ['junk'] },
  { id: RECEIPTS_ID, slug: 'receipts', display_name: 'Receipts', is_system: false, position: 2, roles: [] },
  { id: 'legacy:old', slug: 'old', display_name: 'Old', is_system: false, position: 3, roles: [] },
];
const templates: MailTemplate[] = [{ id: 't-1', name: 'Report', subject: 'Weekly report', body_html: '<p>Numbers attached.</p>', body_text: 'Numbers attached.', updated_at: '2026-10-20T08:00:00.000Z' }];
const calendars = [
  { id: 'c-1', name: 'Personal', color: '#2563eb', account_display_name: 'Local' },
  { id: 'c-2', name: 'Work', color: '#16a34a', account_email: 'alex@example.test' },
];
const mailSettings = (values: Partial<MailAccountSettingValues> = {}) => defaultsResolved({ ...DEFAULT_MAIL_ACCOUNT_SETTINGS, ...values });

// The answers a test may change before mounting.
let userAnswer: { data: { settings: UserSettings } };
let mailAccountAnswer: Record<string, ReturnType<typeof mailSettings>>;

function mount(view: 'general' | 'mail' | 'notifications') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const View = view === 'general' ? GeneralSettings : view === 'mail' ? MailSettings : NotificationChoices;
  return render(<QueryClientProvider client={client}><MemoryRouter><View /></MemoryRouter></QueryClientProvider>);
}
const option = async (combobox: string, name: string | RegExp) => {
  fireEvent.click(screen.getByRole('combobox', { name: combobox }));
  return screen.findByRole('option', { name });
};
const choose = async (combobox: string, name: string | RegExp) => { fireEvent.click(await option(combobox, name)); };

beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  userAnswer = userSettingsAnswer();
  mailAccountAnswer = { 'acc-a': mailSettings(), 'acc-b': mailSettings() };
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/settings/values') return userAnswer;
    if (path === '/settings/values/mail-accounts') return { data: { accounts: mailAccountAnswer } };
    if (path === '/settings/values/calendars') return { data: { calendars: { 'c-1': defaultsResolved(DEFAULT_CALENDAR_SETTINGS) } } };
    if (path === '/mail/accounts') return { data: { accounts } };
    if (path.startsWith('/mail/folders?account_id=')) return { data: { folders } };
    if (path === '/mail/templates') return { data: { templates } };
    if (path === '/calendar/calendars') return { data: { calendars } };
    throw new Error(`unexpected GET ${path}`);
  });
  vi.mocked(api.put).mockImplementation(async (path: string, body: unknown) => {
    if (path === '/settings/values') return savedSettingsAnswer(body);
    const scoped = /^\/settings\/values\/(mail-accounts|calendars)\/(.+)$/.exec(path);
    if (scoped) {
      const defaults = scoped[1] === 'calendars' ? DEFAULT_CALENDAR_SETTINGS : DEFAULT_MAIL_ACCOUNT_SETTINGS;
      return { data: { id: scoped[2], settings: defaultsResolved({ ...defaults, ...(body as { values: object }).values }) } };
    }
    if (path.endsWith('/signature')) { const { html, text } = body as { html: string; text: string }; return { data: { id: path.split('/')[3], signature_html: html || null, signature_text: text || null } }; }
    if (path.startsWith('/mail/templates/')) return { data: { template: { ...templates[0], ...(body as object) } } };
    throw new Error(`unexpected PUT ${path}`);
  });
  vi.mocked(api.post).mockImplementation(async (_path: string, body: unknown) => ({ data: { template: { id: 't-2', updated_at: '', ...(body as object) } } }));
  vi.mocked(api.delete).mockResolvedValue({ data: { deleted: true } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('general settings', () => {
  it('saves the week start and the default reminder with their keys', async () => {
    mount('general');
    const weekStart = await screen.findByRole('combobox', { name: 'Week starts on' });
    await waitFor(() => expect(weekStart).toBeEnabled());
    await choose('Week starts on', 'Sunday');
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values', { values: { week_start: 'sunday' } }));
    await choose('Reminder for new events', 'No reminder');
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values', { values: { default_event_reminder: null } }));
    await choose('Reminder for new events', '1 day before');
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values', { values: { default_event_reminder: 1440 } }));
  });
});

describe('mail settings', () => {
  it('a locked setting is greyed out with its reason, not hidden', async () => {
    userAnswer.data.settings.compose_format = { value: 'plain', source: 'policy', locked: true };
    mount('mail');
    const format = await screen.findByRole('combobox', { name: 'Format' });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Templates' })).toBeEnabled());
    expect(format).toBeDisabled();
    expect(format).toHaveTextContent('Plain text');
    expect(screen.getByText('Set by your administrator')).toBeInTheDocument();
  });

  it('switches a compose feature on, keeps the snooze choices in order, and reverts a failed save', async () => {
    mount('mail');
    const templatesSwitch = await screen.findByRole('switch', { name: 'Templates' });
    await waitFor(() => expect(templatesSwitch).toBeEnabled());
    fireEvent.click(templatesSwitch);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values', { values: { compose_templates: true } }));
    expect(templatesSwitch).toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: '3 hours' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values', { values: { snooze_choices: ['1h', '3h', '1d', '1w'] } }));

    vi.mocked(api.put).mockRejectedValueOnce(new Error('Server says no'));
    const conversations = screen.getByRole('switch', { name: 'Conversations' });
    fireEvent.click(conversations);
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not save the setting', description: 'Server says no', variant: 'destructive' })));
    await waitFor(() => expect(conversations).not.toBeChecked());
  });

  it('adds a formatted template with its plain text, and deletes one after confirming', async () => {
    mount('mail');
    await screen.findByText('Weekly report');
    fireEvent.click(screen.getByRole('button', { name: 'New template' }));
    const dialog = await screen.findByRole('dialog', { name: 'New template' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Thanks ' } });
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'Thank you' } });
    const editor = within(dialog).getByRole('textbox', { name: 'Text' });
    editor.innerHTML = '<p>Thanks for your <b>order</b>.</p><script>alert(1)</script>';
    fireEvent.input(editor);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/templates', { name: 'Thanks', subject: 'Thank you', body_html: '<p>Thanks for your <b>order</b>.</p>', body_text: 'Thanks for your order.' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const section = screen.getByRole('heading', { name: 'Templates' }).closest('section')!;
    fireEvent.click(within(section).getByRole('button', { name: 'Edit' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit template' });
    expect(within(edit).getByLabelText('Name')).toHaveValue('Report');
    fireEvent.click(within(edit).getByRole('button', { name: 'Delete template' }));
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/mail/templates/t-1'));
  });

  it('saves a signature as rich text with its plain version and shows it in the account row', async () => {
    mount('mail');
    const row = (await screen.findByText('bo@example.test')).closest('div')!.parentElement!;
    fireEvent.click(within(row).getByRole('button', { name: 'Add signature' }));
    const dialog = await screen.findByRole('dialog', { name: 'Signature' });
    const editor = within(dialog).getByRole('textbox', { name: 'Signature' });
    editor.innerHTML = '<p>Bo <i>Example</i><br>Example Ltd</p>';
    fireEvent.input(editor);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/accounts/acc-b/signature', { html: '<p>Bo <i>Example</i><br>Example Ltd</p>', text: 'Bo Example\nExample Ltd' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(within(row).getByText('Bo Example')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});

describe('notification choices', () => {
  it('stores a system folder by role and another folder by id, keeping the rest of the list', async () => {
    expect(folderRef(folders[1])).toBe('role:junk');
    expect(folderRef(folders[2])).toBe(`folder:${RECEIPTS_ID}`);
    expect(folderRef(folders[3])).toBeNull();
    expect(toggleFolder(['role:junk', 'role:sent'], { id: 'f-spam', roles: ['junk'] }, false)).toEqual(['role:sent']);

    mount('notifications');
    const alex = (await screen.findByRole('heading', { name: 'alex@example.test' })).closest('section')!;
    const junk = await within(alex).findByRole('checkbox', { name: 'Junk' });
    await waitFor(() => expect(junk).toBeEnabled());
    expect(junk).toBeChecked();
    expect(within(alex).getByRole('checkbox', { name: 'Inbox' })).not.toBeChecked();
    expect(within(alex).queryByRole('checkbox', { name: 'Old' })).not.toBeInTheDocument();
    fireEvent.click(junk);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values/mail-accounts/acc-a', { values: { notify_folders: ['role:sent', 'role:drafts', 'role:trash', 'role:archive'] } }));
    fireEvent.click(within(alex).getByRole('checkbox', { name: 'Receipts' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values/mail-accounts/acc-a', { values: { notify_folders: ['role:sent', 'role:drafts', 'role:trash', 'role:archive', `folder:${RECEIPTS_ID}`] } }));
  });

  it('a floor greys out the less private choices and a switched-off account hides its filter', async () => {
    mailAccountAnswer['acc-a'] = { ...mailSettings({ notify_detail: 'sender' }), notify_detail: { value: 'sender', source: 'policy', locked: false, floor: 'sender' } };
    mailAccountAnswer['acc-b'] = mailSettings({ notify_enabled: false });
    mount('notifications');
    const alex = (await screen.findByRole('heading', { name: 'alex@example.test' })).closest('section')!;
    await waitFor(() => expect(within(alex).getByRole('switch', { name: 'Notifications' })).toBeEnabled());
    expect(within(alex).getByText('Set by your administrator')).toBeInTheDocument();
    const bo = screen.getByRole('heading', { name: 'bo@example.test' }).closest('section')!;
    expect(within(bo).getByRole('switch', { name: 'Notifications' })).not.toBeChecked();
    expect(within(bo).queryByRole('combobox', { name: 'Folders' })).not.toBeInTheDocument();
    fireEvent.click(within(alex).getByRole('combobox', { name: 'What it shows' }));
    expect(await screen.findByRole('option', { name: 'Sender and subject' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: 'Sender only' })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: 'Nothing, just “New email”' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('switches a calendar off and saves the reminder detail', async () => {
    mount('notifications');
    const work = await screen.findByRole('switch', { name: 'Work' });
    await waitFor(() => expect(work).toBeEnabled());
    expect(work).toBeChecked();
    fireEvent.click(work);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values/calendars/c-2', { values: { notify_enabled: false } }));
    await choose('What a reminder shows', 'Nothing, just “Event reminder”');
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/settings/values', { values: { reminder_notification_detail: 'none' } }));
  });
});
