import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailCalendarSettings } from '@/components/mail/MailCalendarSettings';
import { calendarApi, type CalendarAccount, type MailCalendarLink } from '@/lib/calendar-api';
import type { MailAccount } from '@/lib/mail-api';

vi.mock('@/lib/calendar-api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/calendar-api')>();
  return { ...actual, calendarApi: { fetchMailCalendar: vi.fn(), setMailCalendar: vi.fn(), syncAccount: vi.fn() } };
});
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true }) }));
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const mailAccount = { id: 'mail-1', email_address: 'owner@example.test', display_name: null, provider: 'custom', is_active: true, last_synced_at: null } as MailAccount;
const off: MailCalendarLink = { enabled: false, account: null, calendars: [], event_count: 0, provider: null };
const on: MailCalendarLink = {
  enabled: true,
  account: {
    id: 'cal-1', provider: 'caldav', is_active: true, sync_status: 'pending', last_synced_at: null,
    provider_config: { server: { url: 'https://dav.example.test/dav/', source: 'manual', label: 'dav.example.test' } },
  } as CalendarAccount,
  calendars: [{ id: 'c1', name: 'Personal', color: '#2563eb', read_only: false, is_visible: true }],
  event_count: 0,
  provider: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  // The Radix switch measures itself; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  vi.mocked(calendarApi.fetchMailCalendar).mockResolvedValue(off);
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(<QueryClientProvider client={client}><form onSubmit={onSubmit}><MailCalendarSettings account={mailAccount} /></form></QueryClientProvider>);
  return { onSubmit };
}

describe('mail calendar settings', () => {
  it('connects an off calendar with the typed address from the Connect button', async () => {
    vi.mocked(calendarApi.setMailCalendar).mockResolvedValue(on);
    mount();
    const button = await screen.findByRole('button', { name: 'Connect calendar' });
    expect(screen.getByText(/Saving the mail account does not turn the calendar on/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Calendar server address (optional)'), { target: { value: ' https://dav.example.test/dav/ ' } });
    fireEvent.click(button);
    await waitFor(() => expect(calendarApi.setMailCalendar).toHaveBeenCalledExactlyOnceWith('mail-1', expect.objectContaining({ enabled: true, caldav_url: 'https://dav.example.test/dav/' })));
    expect(await screen.findByText(/Personal · 0 events/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect calendar' })).not.toBeInTheDocument();
  });

  it('connects on Enter without submitting the mail account form and keeps the error visible', async () => {
    vi.mocked(calendarApi.setMailCalendar).mockRejectedValue(new Error('No CalDAV server was found for example.test.'));
    const { onSubmit } = mount();
    const input = await screen.findByLabelText('Calendar server address (optional)');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calendarApi.setMailCalendar).toHaveBeenCalledExactlyOnceWith('mail-1', expect.not.objectContaining({ caldav_url: expect.anything() })));
    expect(await screen.findByRole('alert')).toHaveTextContent('Calendar not changed: No CalDAV server was found for example.test.');
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('needs a subscription address before connecting a provider without CalDAV', async () => {
    vi.mocked(calendarApi.fetchMailCalendar).mockResolvedValue({ ...off, provider: { id: 'other', label: 'Other', supported: false, hint: 'Paste the calendar subscription address.' } });
    mount();
    const button = await screen.findByRole('button', { name: 'Connect calendar' });
    expect(button).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Calendar subscription address'), { key: 'Enter' });
    expect(calendarApi.setMailCalendar).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Calendar subscription address'), { target: { value: 'https://calendar.example.test/feed.ics' } });
    expect(button).toBeEnabled();
  });
});
