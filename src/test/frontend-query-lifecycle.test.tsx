import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useQuery, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { invalidateMailQueries } from '@/lib/mail-api';
import { fetchAllContacts } from '@/lib/contacts-api';
import { api } from '@/lib/api';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('private query lifecycle', () => {
  it('discards fresh private data and pending requests at an account boundary', async () => {
    let lateResult!: (value: string) => void;
    let firstSignal!: AbortSignal;
    const query = vi.fn(({ signal }: { signal: AbortSignal }) => {
      if (query.mock.calls.length === 1) {
        firstSignal = signal;
        return new Promise<string>((resolve) => { lateResult = resolve; });
      }
      return Promise.resolve('B private contacts');
    });
    function Contacts() {
      const result = useQuery({ queryKey: ['contacts'], queryFn: query, staleTime: 300000 });
      return <div>{result.data ?? 'Loading contacts'}</div>;
    }
    const { rerender } = render(<SessionQueryProvider key="A"><Contacts /></SessionQueryProvider>);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    rerender(<SessionQueryProvider key="B"><Contacts /></SessionQueryProvider>);
    expect(firstSignal.aborted).toBe(true);
    await screen.findByText('B private contacts');
    await act(async () => { lateResult('A private contacts'); });
    expect(screen.queryByText('A private contacts')).not.toBeInTheDocument();
    expect(screen.getByText('B private contacts')).toBeInTheDocument();
  });

  it('never renders a prior account’s five-minute-fresh contacts after switching', async () => {
    const query = vi.fn().mockResolvedValueOnce('A saved contacts').mockResolvedValueOnce('B saved contacts');
    function Contacts() {
      const result = useQuery({ queryKey: ['contacts'], queryFn: query, staleTime: 300000 });
      return <div>{result.data ?? 'Loading contacts'}</div>;
    }
    const { rerender } = render(<SessionQueryProvider key="A"><Contacts /></SessionQueryProvider>);
    await screen.findByText('A saved contacts');
    rerender(<SessionQueryProvider key="B"><Contacts /></SessionQueryProvider>);
    expect(screen.queryByText('A saved contacts')).not.toBeInTheDocument();
    await screen.findByText('B saved contacts');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('invalidates dashboard unread mail with every mail mutation', async () => {
    const client = new QueryClient();
    client.setQueryData(['dashboard-unread-mail'], [{ id: 'mail' }]);
    client.setQueryData(['mail-unread-counts', 'all'], { inbox: 1 });
    client.setQueryData(['contacts'], [{ id: 'contact' }]);
    await invalidateMailQueries(client);
    expect(client.getQueryState(['dashboard-unread-mail'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['mail-unread-counts', 'all'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['contacts'])?.isInvalidated).toBe(false);
    client.clear();
  });

  it('waits until typing settles before changing a search term', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), { initialProps: { value: '' } });
    for (const value of ['a', 'ab', 'abc', 'abcd']) {
      rerender({ value });
      act(() => { vi.advanceTimersByTime(100); });
      expect(result.current).toBe('');
    }
    act(() => { vi.advanceTimersByTime(150); });
    expect(result.current).toBe('abcd');
  });

  it('loads contacts beyond the first 2000 without losing the final page', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce({ data: {
      contacts: Array.from({ length: 2000 }, (_, index) => ({ id: String(index) })), has_more: true,
    } }).mockResolvedValueOnce({ data: { contacts: [{ id: '2000' }], has_more: false } });
    const controller = new AbortController();
    const contacts = await fetchAllContacts(controller.signal);
    expect(contacts).toHaveLength(2001);
    expect(contacts[contacts.length - 1]?.id).toBe('2000');
    expect(get).toHaveBeenLastCalledWith('/contacts?limit=2000&offset=2000', { signal: controller.signal });
  });
});
