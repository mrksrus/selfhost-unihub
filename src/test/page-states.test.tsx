import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Users } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { NoteDraftProvider } from '@/hooks/use-note-draft';
import { api } from '@/lib/api';
import AdminUsers from '@/pages/AdminUsers';
import Notes from '@/pages/Notes';

vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'admin-1', role: 'admin' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderPage(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><NoteDraftProvider>{children}</NoteDraftProvider></MemoryRouter></QueryClientProvider>);
}

describe('shared page states', () => {
  it('announces loading politely with a visible label and a reduced-motion-safe spinner', () => {
    render(<LoadingState label="Loading contacts…" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Loading contacts…');
    const spinner = status.querySelector('svg');
    expect(spinner?.getAttribute('class')).toContain('motion-safe:animate-spin');
    expect(spinner?.getAttribute('class')).not.toMatch(/(^|\s)animate-spin/);
  });

  it('shows an empty title, description and optional action', () => {
    const onAdd = vi.fn();
    render(<EmptyState icon={Users} title="No contacts yet" description="Add your first contact" action={<button onClick={onAdd}>Add contact</button>} />);
    expect(screen.getByText('No contacts yet')).toBeInTheDocument();
    expect(screen.getByText('Add your first contact')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('shows the error message as an alert and retries', () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Could not load contacts" error={new Error('Server unavailable')} onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load contacts');
    expect(alert).toHaveTextContent('Server unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('falls back to a plain message and disables retry while retrying', () => {
    render(<ErrorState title="Could not load" error={{}} onRetry={() => {}} retrying />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Check your connection and try again.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
  });

  it('omits the retry button when no retry is possible', () => {
    render(<ErrorState title="Could not load" error="Offline" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('page error states', () => {
  it('shows a users error instead of an empty table and recovers on retry', async () => {
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce({ error: 'Database unavailable' })
      .mockResolvedValue({ data: { users: [{ id: 'u1', email: 'ada@example.test', full_name: 'Ada Lovelace', role: 'user', is_active: true, created_at: '2026-09-01T12:00:00Z' }] } });
    renderPage(<AdminUsers />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load users');
    expect(alert).toHaveTextContent('Database unavailable');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('ada@example.test')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not show an empty notes message when the list failed to load', async () => {
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce({ error: 'Notes are unavailable' })
      .mockResolvedValue({ data: { notes: [] } });
    renderPage(<Notes />);
    expect(await screen.findByText('Notes are unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No notes yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
  });
});
