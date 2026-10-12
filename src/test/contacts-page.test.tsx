import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Contacts from '@/pages/Contacts';
import { api } from '@/lib/api';
import type { Contact } from '@/lib/contacts-api';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn() } }));

const contact = (id: string, patch: Partial<Contact>): Contact => ({
  id, first_name: '', last_name: null, email: null, email2: null, email3: null, phone: null, phone2: null, phone3: null,
  company: null, job_title: null, notes: null, avatar_url: null, is_favorite: false, ...patch,
});
const contacts = [
  contact('ada', { first_name: 'Ada', last_name: 'Example', email: 'ada@example.com', company: 'Test Kitchen Co.' }),
  contact('ada-2', { first_name: 'Ada', last_name: 'Sample', email: 'ADA@example.com' }),
  contact('ben', { first_name: 'Ben', last_name: 'Sample', phone: '+1 555 0100', is_favorite: true }),
  contact('nameless', { email: 'someone@example.org' }),
];

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function mount(path = '/contacts', preferences = { email_link_behavior: 'mailto' }) {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.startsWith('/contacts')) return { data: { contacts, has_more: false } };
    if (url === '/settings/preferences') return { data: { preferences } };
    return { data: {} };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="*" element={<><Contacts /><Location /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.post).mockResolvedValue({ data: {} });
  vi.mocked(api.put).mockResolvedValue({ data: {} });
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Contacts', () => {
  it('lists contacts by name and offers only the views that have contacts', async () => {
    mount();
    expect(await screen.findByRole('button', { name: /^Ada Example/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Favorites, 1 contacts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Possible duplicates, 2 contacts/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Name only/ })).not.toBeInTheDocument();
    // A contact with only an address is listed under that address.
    expect(screen.getByRole('button', { name: /^someone@example.org/ })).toBeInTheDocument();
  });

  it('opens a contact with its address as a link and composes in UniHub when that is the preference', async () => {
    mount('/contacts', { email_link_behavior: 'internal' });
    fireEvent.click(await screen.findByRole('button', { name: /^Ada Example/ }));
    const detail = await screen.findByRole('article', { name: 'Ada Example' });
    fireEvent.click(within(detail).getByRole('link', { name: /ada@example.com/ }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/^\/mail\?action=compose&to=ada%40example.com/));
  });

  it('asks before deleting a contact', async () => {
    mount('/contacts?contact=ben');
    const detail = await screen.findByRole('article', { name: 'Ben Sample' });
    fireEvent.pointerDown(within(detail).getByRole('button', { name: 'More actions for Ben Sample' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete contact' }));
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/contacts/ben'));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/contacts'));
  });

  it('selects contacts with their avatars and deletes them together after a confirmation', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Select Ada Example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Ben Sample' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alertdialog', { name: 'Delete 2 contacts?' })).toBeInTheDocument();
    vi.mocked(api.post).mockResolvedValueOnce({ data: { deleted: 2 } });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/contacts/bulk-delete', { ids: ['ada', 'ben'] }));
    expect(state.toast).toHaveBeenCalledWith({ title: '2 contacts deleted' });
  });

  it('prefills a new contact from a link and saves extra addresses in order', async () => {
    mount('/contacts?action=new&name=Robin&email=robin@example.com');
    const dialog = await screen.findByRole('dialog', { name: 'New contact' });
    expect(within(dialog).getByLabelText('First name')).toHaveValue('Robin');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add another email' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Email 2' }), { target: { value: 'robin@work.example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add contact' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/contacts', expect.objectContaining({
      first_name: 'Robin', email: 'robin@example.com', email2: 'robin@work.example', email3: '',
    })));
    expect(screen.getByTestId('location').textContent).toBe('/contacts');
  });
});
