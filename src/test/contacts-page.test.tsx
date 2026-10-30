import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Contacts from '@/pages/Contacts';
import { api } from '@/lib/api';
import { contact, duplicateGroup } from './contact-fixtures';
import { userSettingsAnswer } from './settings-fixtures';
import type { UserSettingValues } from '@/lib/settings-api';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/platform', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), saveFile: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), getBlob: vi.fn(), postBlob: vi.fn(), uploadBlob: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));

const contacts = [
  contact('ada', { name: { given: 'Ada', family: 'Example' }, emails: ['ada@example.com'], organization: { name: 'Test Kitchen Co.' } }),
  contact('ada-2', { name: { given: 'Ada', family: 'Sample' }, emails: ['ADA@example.com'] }),
  contact('ben', { name: { given: 'Ben', family: 'Sample' }, phones: [{ value: '+1 555 0100', label: 'mobile', preferred: true }, '+1 555 0199'], is_favorite: true }),
  contact('nameless', { emails: ['someone@example.org'] }),
];
const groups = [duplicateGroup('g1', [contacts[0], contacts[1]], { conflicts: ['name'], reasons: [{ kind: 'email', detail: 'ada@example.com', a: 'ada', b: 'ada-2' }] })];

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function mount(path = '/contacts', preferences: Partial<UserSettingValues> = { email_link_behavior: 'mailto' }, duplicates: { data?: unknown; error?: string; status?: number } = { data: { groups } }) {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.startsWith('/contacts/duplicates')) return duplicates;
    if (url === '/contacts/merges') return { data: { merges: [] } };
    if (url.startsWith('/contacts')) return { data: { contacts, has_more: false } };
    if (url === '/settings/values') return userSettingsAnswer(preferences);
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
  // The Radix checkbox measures itself; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  vi.mocked(api.post).mockResolvedValue({ data: {} });
  vi.mocked(api.put).mockResolvedValue({ data: {} });
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Contacts', () => {
  it('lists contacts by name, shows the preferred number, and offers only the views that have contacts', async () => {
    mount();
    expect(await screen.findByRole('button', { name: /^Ada Example/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Ben Sample/ })).toHaveTextContent('+1 555 0100');
    expect(screen.getByRole('button', { name: /^Favorites, 1 contacts/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Possible duplicates, 1 groups/ })).toBeInTheDocument();
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

  it('selects with Ctrl+click and Shift+click without opening, and clears with Escape', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Ada Example/ }), { ctrlKey: true });
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByTestId('location').textContent).toBe('/contacts');
    fireEvent.click(screen.getByRole('button', { name: /^Ben Sample/ }), { shiftKey: true });
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('3 selected')).not.toBeInTheDocument();
  });

  it('sets a company on the selected contacts and sends only the ticked field', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Select Ada Example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Ben Sample' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set company…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set company for 2 contacts' });
    expect(within(dialog).getByRole('button', { name: 'Update 2 contacts' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Company' }), { target: { value: 'Example Ltd' } });
    vi.mocked(api.post).mockResolvedValueOnce({ data: { updated: 2 } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update 2 contacts' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/contacts/bulk-update', { ids: ['ada', 'ben'], contact: { company: 'Example Ltd' } }));
    expect(state.toast).toHaveBeenCalledWith({ title: '2 contacts updated' });
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument());
  });

  it('exports the selection in the chosen format and all contacts from the panel', async () => {
    mount();
    vi.mocked(api.postBlob).mockResolvedValue({ blob: new Blob(['BEGIN:VCARD']), filename: 'contacts.vcf' });
    vi.mocked(api.getBlob).mockResolvedValue({ blob: new Blob(['Name']), filename: 'contacts.csv' });
    fireEvent.click(await screen.findByRole('button', { name: 'Select Ada Example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export selected' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export 1 selected contact' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(api.postBlob).toHaveBeenCalledWith('/contacts/export', { ids: ['ada'], format: 'vcard4' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Export all contacts' }));
    const all = await screen.findByRole('dialog', { name: 'Export all contacts' });
    fireEvent.click(within(all).getByRole('radio', { name: /Google CSV/ }));
    fireEvent.click(within(all).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(api.getBlob).toHaveBeenCalledWith('/contacts/export?format=google-csv'));
  });

  it('prefills a new contact from a link and saves the full body with labelled emails', async () => {
    mount('/contacts?action=new&name=Robin%20Example&email=robin@example.com');
    const dialog = await screen.findByRole('dialog', { name: 'New contact' });
    expect(within(dialog).getByLabelText('First name')).toHaveValue('Robin');
    expect(within(dialog).getByLabelText('Last name')).toHaveValue('Example');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add another email' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Email 2' }), { target: { value: 'robin@work.example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preferred email 2' }));
    vi.mocked(api.post).mockResolvedValueOnce({ data: { contact: contact('new', { name: { given: 'Robin' } }) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add contact' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/contacts', expect.objectContaining({
      name: expect.objectContaining({ given: 'Robin', family: 'Example' }),
      emails: [
        expect.objectContaining({ value: 'robin@example.com', label: '', preferred: false }),
        expect.objectContaining({ value: 'robin@work.example', label: 'home', preferred: true }),
      ],
    })));
    expect(screen.getByTestId('location').textContent).toBe('/contacts');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the duplicate groups with their reasons and reviews a group before merging', async () => {
    mount('/contacts?view=duplicates');
    const group = await screen.findByRole('region', { name: /Group of 2, high confidence/ });
    expect(group).toHaveTextContent('Same email ada@example.com');
    fireEvent.click(within(group).getByRole('button', { name: 'Review and merge' }));
    const review = await screen.findByRole('dialog', { name: 'Merge 2 contacts into one' });
    // Both names differ: the merge waits for a choice.
    expect(within(review).getByRole('button', { name: 'Merge' })).toBeDisabled();
    fireEvent.click(within(review).getByRole('radio', { name: 'Ada Sample' }));
    vi.mocked(api.post).mockResolvedValueOnce({ data: { merge_id: 'm1', contact: contacts[1], merged_ids: ['ada'] } });
    fireEvent.click(within(review).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/contacts/merges', {
      contact_ids: ['ada', 'ada-2'], survivor_id: 'ada-2', choices: { name: 'ada-2' }, versions: { ada: 1, 'ada-2': 1 },
    }));
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Merged into Ada Sample' }));
  });

  it('shows a retryable error instead of a crash when the duplicates route is missing', async () => {
    mount('/contacts?view=duplicates', { email_link_behavior: 'mailto' }, { error: 'The requested API endpoint was not found.', status: 404 });
    expect(await screen.findByText('Could not check for duplicates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^All contacts/ })).toBeInTheDocument();
  });
});
