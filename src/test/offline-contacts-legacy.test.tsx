import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Contacts from '@/pages/Contacts';
import { api } from '@/lib/api';
import { resolveOfflineEndpoint, type OfflineSnapshot } from '@/lib/offline';
import { contactEmails, type Contact } from '@/lib/contacts-api';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn(), postBlob: vi.fn(), uploadBlob: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));

// A snapshot saved by UniHub 0.25 (format version 1, the 3+3 columns), as an
// installed app may still hold it after the server moved to 0.26.
const legacySnapshot: OfflineSnapshot = {
  version: 1, userId: 'A', savedAt: '2026-10-20T10:00:00Z', bytes: 0, user: { id: 'A', email: 'a@example.test' },
  contacts: [
    { id: 'c-1', user_id: 'A', first_name: 'Olga', last_name: 'Oldsnapshot', email: 'olga@example.com', email2: null, email3: 'olga.third@example.org',
      phone: '+49 171 5550100', phone2: '+49 30 5550101', phone3: null, company: 'Example GmbH', job_title: 'Engineer', notes: 'Saved by 0.25', is_favorite: 1, avatar_url: null },
    { id: 'c-2', user_id: 'A', first_name: '', last_name: null, email: 'nameless@example.org', email2: null, email3: null, phone: null, phone2: null, phone3: null,
      company: null, job_title: null, notes: null, is_favorite: 0 },
  ],
  events: [], calendars: [], calendarAccounts: [], mailAccounts: [], folders: [], emails: [],
} as unknown as OfflineSnapshot;

const offline = (endpoint: string) => resolveOfflineEndpoint(legacySnapshot, endpoint) as { data: { contacts: Contact[] } };

beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  vi.mocked(api.get).mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('/settings') || endpoint.startsWith('/contacts/duplicates') || endpoint === '/contacts/merges') return { error: 'Offline', status: 503 };
    return resolveOfflineEndpoint(legacySnapshot, endpoint) as never;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('a pre-0.26 offline snapshot', () => {
  it('answers contacts in the current read model', () => {
    const [olga, nameless] = offline('/contacts').data.contacts;
    expect(olga).toMatchObject({
      display_name: 'Olga Oldsnapshot', name: { given: 'Olga', family: 'Oldsnapshot', display: null }, organization: { name: 'Example GmbH', department: null },
      job_title: 'Engineer', is_favorite: true, addresses: [], urls: [], categories: [], photo: null, kept_properties: 0,
    });
    expect(olga.emails.map(entry => entry.value)).toEqual(['olga@example.com', 'olga.third@example.org']);
    expect(olga.phones.map(entry => entry.value)).toEqual(['+49 171 5550100', '+49 30 5550101']);
    // What the composer's suggestions read.
    expect(contactEmails(olga)).toEqual(['olga@example.com', 'olga.third@example.org']);
    expect(nameless).toMatchObject({ display_name: 'nameless@example.org', name: { given: null } });
    expect(offline('/contacts?q=third@').data.contacts.map(row => row.id)).toEqual(['c-1']);
    expect(offline('/contacts?q=0171%205550').data.contacts.map(row => row.id)).toEqual(['c-1']);
    expect(offline('/contacts?group=number_or_email_only').data.contacts.map(row => row.id)).toEqual(['c-2']);
  });

  it('opens on the contacts page, with its detail and search', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/contacts?contact=c-1']}><Routes><Route path="*" element={<Contacts />} /></Routes></MemoryRouter>
      </QueryClientProvider>,
    );
    const detail = await screen.findByRole('article', { name: 'Olga Oldsnapshot' }, { timeout: 5000 });
    expect(within(detail).getByText('olga.third@example.org')).toBeInTheDocument();
    expect(within(detail).getByText('+49 30 5550101')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^nameless@example.org/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search contacts' }), { target: { value: 'Oldsnapshot' } });
    expect(await screen.findByRole('button', { name: /^Olga Oldsnapshot/ }, { timeout: 3000 })).toBeInTheDocument();
  });
});
