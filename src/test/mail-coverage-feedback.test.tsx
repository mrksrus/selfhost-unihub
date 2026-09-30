import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MailSyncJobs } from '@/components/mail/MailSyncJobs';
import type { MailSyncJob } from '@/hooks/use-mail-sync-jobs';

const base: MailSyncJob = { account_id: 'a1', state: 'running', phase: 'history', processed: 8, total: null,
  started_at: null, updated_at: null, error: null };
const accounts = [{ id: 'a1', email_address: 'owner@example.test', display_name: 'Owner', provider: 'custom', is_active: true, last_synced_at: null }];
const view = (job: MailSyncJob) => render(<MailSyncJobs accounts={accounts} jobs={[job]} error={false} cancelling={new Set()} onCancel={vi.fn()} />);

describe('coverage-aware sync feedback', () => {
  it('distinguishes recent coverage from pending history and bodies with unknown total', () => {
    view({ ...base, coverage: { recent: { current: true }, history: { complete: false }, bodies: { complete: false } } });
    expect(screen.getByText(/Inbox current/)).toBeInTheDocument();
    expect(screen.getByText(/Older mail not fully covered/)).toBeInTheDocument();
    expect(screen.getByText(/Bodies still downloading/)).toBeInTheDocument();
    expect(screen.getByText(/8 processed/)).toBeInTheDocument();
    expect(screen.queryByText(/Sync complete/)).not.toBeInTheDocument();
  });
  it('never infers complete history from an idle job or a covered UID window', () => {
    view({ ...base, state: 'idle', coverage: { recent: { /* window metadata is not freshness */ }, history: { complete: false } } });
    expect(screen.getByText(/No sync job running/)).toBeInTheDocument();
    expect(screen.getByText(/Older mail not fully covered/)).toBeInTheDocument();
    expect(screen.queryByText(/Inbox current/)).not.toBeInTheDocument();
  });
  it('shows paused provider state and requested cancellation without claiming completion', () => {
    view({ ...base, state: 'paused', phase: 'auth', error: 'Credentials needed' });
    expect(screen.getByText(/Waiting for provider or credentials/)).toBeInTheDocument();
    expect(screen.getByText(/Credentials needed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel sync/ })).not.toBeInTheDocument();
  });
});
