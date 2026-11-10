import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '@/components/settings/AuditLog';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const today = new Date().toISOString();

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => vi.resetAllMocks());

describe('Activity log', () => {
  it('pages back through older entries with the server cursor', async () => {
    const entry = (id: string, action: string, details: Record<string, string> | null = null) => ({
      id, createdAt: today, action, details, ipAddress: '203.0.113.5', requestId: null,
      actor: { id: 'admin-1', email: 'admin@example.test' }, target: { id: 'user-2', email: 'person@example.test' },
    });
    vi.mocked(api.get).mockImplementation(async (path: string) => path.includes('before=')
      ? { data: { entries: [entry('e2', 'admin.password_reset')], cursor: null } }
      : { data: { entries: [entry('e1', 'admin.role_changed', { role: 'admin' })], cursor: `${today}|e1` } });
    mount(<AuditLog />);

    expect(await screen.findByText('Changed the role to admin')).toBeInTheDocument();
    expect(screen.getByText(/^person@example\.test · by admin@example\.test · 203\.0\.113\.5/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('Set a new password')).toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith(`/admin/audit?before=${encodeURIComponent(`${today}|e1`)}`, expect.anything());
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
  });
});
