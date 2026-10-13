import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { Email } from '@/lib/mail-api';
import { closeMailPeek, openMailPeek } from '@/lib/mail-peek';
import { MailPeek } from '@/components/mail/MailPeek';
import { SourceEmailBlock } from '@/components/todo/SourceEmail';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner', timezone: 'UTC' } }), useUserTimezone: () => 'UTC' }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn() } }));

const email: Email = {
  id: 'email-7', mail_account_id: 'account-1', subject: 'Invoice 4711 for October', from_address: 'billing@power.example', from_name: 'Power Co',
  to_addresses: ['alex@example.test'], body_text: 'IBAN DE12 3456 7890, 84.20 EUR', body_html: null, folder: 'inbox', is_read: true, is_starred: false,
  received_at: '2026-10-10T08:00:00.000Z', has_attachments: false, attachments: [], tasks: [],
};
const source = { email_id: 'email-7', subject: 'Invoice 4711 for October', from_name: 'Power Co', from_address: 'billing@power.example',
  received_at: '2026-10-10T08:00:00.000Z', attachments: [], account: null, available: true };

function Page() {
  const location = useLocation();
  return <div><p>Task notes: pay by Friday</p><p data-testid="where">{location.pathname}{location.search}</p><SourceEmailBlock source={source} timezone="UTC" /><MailPeek /></div>;
}
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/todo']}>
    <Routes><Route path="/todo" element={<Page />} /><Route path="/mail" element={<Page />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/mail/emails/email-7') return { data: { email } };
    if (path.startsWith('/calendar/calendars')) return { data: { calendars: [] } };
    return { data: { contacts: [] } };
  });
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'sent' } });
});
afterEach(() => { cleanup(); closeMailPeek(); vi.clearAllMocks(); });

describe('the email peek', () => {
  it('shows the email over the page, can be set aside and brought back, and opens Mail only on request', async () => {
    wrap();
    fireEvent.click(screen.getByRole('button', { name: 'Show email' }));
    const peek = await screen.findByRole('dialog', { name: 'Email' });
    expect(await within(peek).findByText('IBAN DE12 3456 7890, 84.20 EUR')).toBeInTheDocument();
    // The page stays where it is and readable.
    expect(screen.getByText('Task notes: pay by Friday')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/todo');

    fireEvent.click(within(peek).getByRole('button', { name: 'Set aside' }));
    const bar = await screen.findByRole('region', { name: 'Email set aside' });
    expect(within(bar).getByText('Invoice 4711 for October')).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: /Bring back/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Email set aside' })).not.toBeInTheDocument());

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Email' })).getByRole('link', { name: /Open in Mail/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/mail?email=email-7'));
    expect(screen.queryByRole('dialog', { name: 'Email' })).not.toBeInTheDocument();
  });

  it('replies from the account the email belongs to without leaving the page', async () => {
    wrap();
    fireEvent.click(screen.getByRole('button', { name: 'Show email' }));
    const peek = await screen.findByRole('dialog', { name: 'Email' });
    await within(peek).findByText('IBAN DE12 3456 7890, 84.20 EUR');
    fireEvent.click(within(peek).getByRole('button', { name: 'Reply' }));
    const to = await within(peek).findByLabelText('To');
    expect(to).toHaveValue('billing@power.example');
    expect(within(peek).getByLabelText('Subject')).toHaveValue('Re: Invoice 4711 for October');
    fireEvent.click(within(peek).getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/send', expect.objectContaining({ account_id: 'account-1', to: 'billing@power.example' })));
    expect(screen.getByTestId('where')).toHaveTextContent('/todo');
    await waitFor(() => expect(within(peek).queryByLabelText('To')).not.toBeInTheDocument());
  });

  it('asks before an unsaved reply is left for another email or for Mail', async () => {
    wrap();
    fireEvent.click(screen.getByRole('button', { name: 'Show email' }));
    const peek = await screen.findByRole('dialog', { name: 'Email' });
    await within(peek).findByText('IBAN DE12 3456 7890, 84.20 EUR');
    fireEvent.click(within(peek).getByRole('button', { name: 'Reply' }));
    fireEvent.change(await within(peek).findByLabelText('Subject'), { target: { value: 'Re: paid on Friday' } });

    act(() => openMailPeek('email-8'));
    const prompt = await screen.findByRole('alertdialog', { name: 'Save this draft?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(within(peek).getByLabelText('Subject')).toHaveValue('Re: paid on Friday');
    expect(api.get).not.toHaveBeenCalledWith('/mail/emails/email-8', expect.anything());

    fireEvent.click(within(peek).getByRole('link', { name: /Open in Mail/ }));
    const again = await screen.findByRole('alertdialog', { name: 'Save this draft?' });
    expect(screen.getByTestId('where')).toHaveTextContent('/todo');
    fireEvent.click(within(again).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/mail?email=email-7'));
    expect(screen.queryByRole('dialog', { name: 'Email' })).not.toBeInTheDocument();
  });
});
