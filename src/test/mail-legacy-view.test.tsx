import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MailAccountList } from '@/components/mail/MailSidebar';
import type { MailAccount } from '@/lib/mail-api';

const account = { id: 'account-1', email_address: 'person@example.test', display_name: 'Person' } as MailAccount;

const list = (legacyCount: number) => render(
  <MailAccountList accounts={[account]} loading={false} selectedAccount="all" legacyCount={legacyCount} compact={false}
    addAccount={null} onSelect={vi.fn()} onEdit={vi.fn()} onRemove={vi.fn()} />,
);

describe('Legacy mail view', () => {
  it('is hidden while no mail needs review', () => {
    list(0);
    expect(screen.queryByText(/^Legacy/)).not.toBeInTheDocument();
  });

  it('is listed while mail needs review', () => {
    list(2);
    expect(screen.getByText('Legacy (2)')).toBeInTheDocument();
  });
});
