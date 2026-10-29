import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useContactActions } from '@/hooks/use-contact-actions';
import { ContactEditor, type ContactEditorTarget } from '@/components/contacts/ContactEditor';
import { dateOfDraft, formOf, toInput, validate } from '@/components/contacts/contact-editor-form';
import { contact } from './contact-fixtures';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), uploadBlob: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));

function Host({ target, onClose }: { target: ContactEditorTarget; onClose: () => void }) {
  const actions = useContactActions();
  return <ContactEditor target={target} onClose={onClose} actions={actions} />;
}

function mount(target: ContactEditorTarget) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Host target={target} onClose={onClose} /></QueryClientProvider>);
  return onClose;
}

const existing = contact('ada', {
  version: 3, name: { given: 'Ada', family: 'Example' }, emails: [{ value: 'ada@example.com', label: 'work', preferred: true }],
  phones: [{ value: '+1 555 0100', label: 'mobile' }, { value: '+1 555 0101', label: 'custom', custom_label: 'Boat' }],
  birthday: { year: null, month: 3, day: 14 }, categories: ['Family'],
  addresses: [{ id: 'a1', value: '', label: 'home', custom_label: null, preferred: false, po_box: null, extended: null, street: '1 Example Street', locality: 'Exampleton', region: null, postal_code: '12345', country: 'Examplia' }],
});

beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  vi.mocked(api.put).mockResolvedValue({ data: { contact: existing } });
  vi.mocked(api.post).mockResolvedValue({ data: { contact: existing } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('contact editor form', () => {
  it('turns a contact into a form that shows only the sections it holds, and back into a full body', () => {
    const form = formOf(existing);
    expect(form.shown).toEqual(['addresses', 'birthday', 'categories']);
    expect(form.birthday).toEqual({ year: '', month: '3', day: '14' });
    const body = toInput(form, existing.version);
    expect(body.version).toBe(3);
    expect(body.birthday).toBe('--03-14');
    expect(body.phones).toEqual([
      { id: 'v0', value: '+1 555 0100', label: 'mobile', custom_label: null, preferred: false },
      { id: 'v1', value: '+1 555 0101', label: 'custom', custom_label: 'Boat', preferred: false },
    ]);
    expect(body.addresses).toEqual([expect.objectContaining({ id: 'a1', street: '1 Example Street', postal_code: '12345', region: null })]);
    expect(body.categories).toEqual(['Family']);
  });

  it('accepts a date without a year, refuses half a date and an impossible day', () => {
    expect(dateOfDraft({ year: '', month: '2', day: '29' })).toEqual({ date: { year: null, month: 2, day: 29 } });
    expect(dateOfDraft({ year: '2023', month: '2', day: '29' }).error).toBe('That is not a date.');
    expect(dateOfDraft({ year: '', month: '2', day: '' }).error).toMatch(/Choose a month and a day/);
    expect(dateOfDraft({ year: '', month: '', day: '' })).toEqual({ date: null });
  });

  it('needs one identity and a text for every custom label', () => {
    const form = formOf(contact('x'));
    expect(validate(form).identity).toBeDefined();
    form.phones[0] = { ...form.phones[0], value: '123', label: 'custom', custom_label: '' };
    expect(validate(form).identity).toBeUndefined();
    expect(validate(form).labels).toBe('Give every custom label a name.');
  });
});

// The editor renders many Radix selects; jsdom needs more than the default 5 s under a full-suite load.
describe('ContactEditor', { timeout: 20_000 }, () => {
  it('adds fields from the menu, labels values, and sends the version with a full body', async () => {
    const onClose = mount({ kind: 'edit', contact: existing });
    const dialog = await screen.findByRole('dialog', { name: 'Edit contact' });
    expect(within(dialog).getByRole('textbox', { name: 'Phone 2' })).toHaveValue('+1 555 0101');
    expect(within(dialog).getByRole('textbox', { name: 'Custom label of phone 2' })).toHaveValue('Boat');
    expect(within(dialog).getByRole('textbox', { name: 'Street' })).toHaveValue('1 Example Street');
    expect(within(dialog).getByRole('textbox', { name: 'Birthday year (optional)' })).toHaveValue('');
    expect(within(dialog).queryByRole('textbox', { name: 'Nickname' })).not.toBeInTheDocument();

    fireEvent.pointerDown(within(dialog).getByRole('button', { name: 'Add field' }), { button: 0 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Nickname' }));
    const nickname = await within(dialog).findByRole('textbox', { name: 'Nickname' });
    fireEvent.change(nickname, { target: { value: 'Addie' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove phone 1' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/contacts/ada', expect.objectContaining({
      version: 3,
      phones: [expect.objectContaining({ value: '+1 555 0101', label: 'custom', custom_label: 'Boat' })],
      nicknames: [expect.objectContaining({ value: 'Addie', label: 'short_name' })],
      birthday: '--03-14',
    })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('refuses a half date and an empty contact before sending anything', async () => {
    mount({ kind: 'new' });
    const dialog = await screen.findByRole('dialog', { name: 'New contact' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add contact' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Add a name, an organisation, an email or a phone number.');
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Robin' } });
    fireEvent.pointerDown(within(dialog).getByRole('button', { name: 'Add field' }), { button: 0 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Birthday' }));
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Birthday day' }), { target: { value: '14' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add contact' }));
    expect(await within(dialog).findByText('Choose a month and a day; the year may stay empty.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('keeps the edits and offers both ways out when the contact changed meanwhile', async () => {
    const theirs = contact('ada', { version: 4, name: { given: 'Ada', family: 'Example-Changed' } });
    vi.mocked(api.put).mockResolvedValueOnce({ error: 'The contact changed meanwhile', status: 409, code: 'VERSION_CONFLICT', contact: theirs });
    const onClose = mount({ kind: 'edit', contact: existing });
    const dialog = await screen.findByRole('dialog', { name: 'Edit contact' });
    fireEvent.change(within(dialog).getByLabelText('Last name'), { target: { value: 'Mine' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/changed on another device meanwhile/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Last name')).toHaveValue('Mine');
    expect(onClose).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save mine anyway' }));
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/contacts/ada', expect.objectContaining({ version: 4, name: expect.objectContaining({ family: 'Mine' }) })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('saves the contact first and keeps the editor open when the photo fails', async () => {
    vi.mocked(api.uploadBlob).mockResolvedValueOnce({ error: 'This picture could not be read. JPEG, PNG, WebP, HEIC, AVIF and GIF work.', status: 400 });
    globalThis.URL.createObjectURL ??= () => 'blob:preview';
    globalThis.URL.revokeObjectURL ??= () => {};
    const onClose = mount({ kind: 'edit', contact: existing });
    const dialog = await screen.findByRole('dialog', { name: 'Edit contact' });
    const file = new File(['<svg/>'], 'photo.svg', { type: 'image/svg+xml' });
    fireEvent.change(within(dialog).getByLabelText('Choose photo'), { target: { files: [file] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.uploadBlob).toHaveBeenCalledWith('/contacts/ada/photo', file, 'image/svg+xml', 'PUT'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This picture could not be read');
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
