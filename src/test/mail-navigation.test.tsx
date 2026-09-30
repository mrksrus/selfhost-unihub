import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, act, screen } from '@testing-library/react';
import { Folder } from 'lucide-react';
import MailFolderNavigation from '@/components/mail/MailFolderNavigation';
import { useMailAccountSelection } from '@/hooks/use-mail-account-selection';

afterEach(cleanup);

describe('mail navigation', () => {
  it('virtual views never provide an account for sending or syncing', () => {
    const { result } = renderHook(useMailAccountSelection);
    act(() => result.current.selectAccount('account-b'));
    expect(result.current.accountId).toBe('account-b');
    for (const view of ['all', 'legacy', null]) {
      act(() => result.current.selectAccount(view));
      expect(result.current.accountId).toBeNull();
      expect(result.current.queryAccount).toBe(view);
    }
  });

  it('finds a custom folder even when its group is collapsed, preserving its actual ID', () => {
    const onSelect = vi.fn();
    render(<MailFolderNavigation folders={[{ id: 'inbox', label: 'Inbox', icon: Folder }, { id: 'bank-42', label: 'Important bank mail', icon: Folder }]} systemIds={['inbox']} selectedFolder="inbox" accountLabel="Personal mail" collapsed={false} unreadByFolder={{}} onSelect={onSelect} onManage={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Custom folders/ }));
    expect(screen.queryByRole('button', { name: 'Important bank mail' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find a folder' }), { target: { value: 'BANK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Important bank mail' }));
    expect(onSelect).toHaveBeenCalledWith('bank-42');
  });

  it('keeps names accessible when only icons are visible', () => {
    render(<MailFolderNavigation folders={[{ id: 'inbox', label: 'Inbox', icon: Folder }]} systemIds={['inbox']} selectedFolder="inbox" accountLabel="Personal mail" collapsed unreadByFolder={{ inbox: 2 }} onSelect={() => {}} onManage={() => {}} />);
    expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Manage folders' })).toBeTruthy();
  });
});
