import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MailAccountModeSettings } from '@/components/mail/MailAccountModeSettings';

describe('mail account modes', () => {
  it('replaces deletion control with explicit existing-account Sync consent', () => {
    const props = { mode: 'download' as const, deleteOnServer: false, requiresConfirmation: true, confirmed: false, onModeChange: vi.fn(), onDeleteChange: vi.fn(), onConfirmChange: vi.fn() };
    const view = render(<MailAccountModeSettings {...props} />);
    expect(screen.getByText('Delete emails on server after download')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sync' } });
    expect(props.onModeChange).toHaveBeenCalledWith('sync');
    view.rerender(<MailAccountModeSettings {...props} mode="sync" />);
    expect(screen.queryByText('Delete emails on server after download')).not.toBeInTheDocument();
    const consent = screen.getByRole('checkbox');
    expect(consent).toBeRequired();
    fireEvent.click(consent);
    expect(props.onConfirmChange).toHaveBeenCalledWith(true);
    expect(screen.getByText(/no longer on the server stay here/)).toBeInTheDocument();
    view.rerender(<MailAccountModeSettings {...props} saveDownloadFirst />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/Save Download mode first/)).toBeInTheDocument();
  });
});
