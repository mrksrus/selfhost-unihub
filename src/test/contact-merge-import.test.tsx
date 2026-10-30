import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useContactActions } from '@/hooks/use-contact-actions';
import { MergeReviewDialog } from '@/components/contacts/MergeReviewDialog';
import { ContactImportDialog } from '@/components/contacts/ContactImportDialog';
import type { DuplicateGroup, ImportSummary } from '@/lib/contacts-api';
import { contact, duplicateGroup } from './contact-fixtures';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), uploadBlob: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const anna = contact('a1', { name: { given: 'Anna', family: 'Example' }, organization: { name: 'Example Labs' }, emails: [{ value: 'anna@example.com', label: 'work' }], phones: ['+1 555 0100'] });
const annaToo = contact('a2', { name: { given: 'Anna', family: 'Example' }, organization: { name: 'Example GmbH' }, emails: ['ANNA@example.com', 'anna.e@example.net'], phones: ['+1 555 0100', '+1 555 0177'] });

function MergeHost({ group, onClose }: { group: DuplicateGroup | null; onClose: () => void }) {
  const actions = useContactActions();
  return <MergeReviewDialog group={group} contacts={[anna, annaToo]} onClose={onClose} actions={actions} />;
}

beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  vi.mocked(api.post).mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('MergeReviewDialog', () => {
  it('lists every number and email as kept with no way to untick, and needs the organisation chosen', async () => {
    const group = duplicateGroup('g', [anna, annaToo], { conflicts: ['organization'] });
    const onClose = vi.fn();
    render(<QueryClientProvider client={client()}><MergeHost group={group} onClose={onClose} /></QueryClientProvider>);
    const dialog = await screen.findByRole('dialog', { name: 'Merge 2 contacts into one' });
    const kept = within(dialog).getByRole('region', { name: 'Kept from all contacts' });
    expect(within(kept).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      expect.stringContaining('+1 555 0100'), expect.stringContaining('+1 555 0177'),
      expect.stringContaining('anna@example.com'), expect.stringContaining('anna.e@example.net'),
    ]);
    expect(within(kept).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(kept).getAllByRole('listitem')[0]).toHaveTextContent('in both');
    const mergeButton = within(dialog).getByRole('button', { name: 'Merge' });
    expect(mergeButton).toBeDisabled();
    expect(within(dialog).getByText('Choose one')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Example GmbH' }));
    expect(mergeButton).toBeEnabled();
    vi.mocked(api.post).mockResolvedValueOnce({ data: { merge_id: 'm1', contact: anna, merged_ids: ['a2'] } });
    fireEvent.click(mergeButton);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/contacts/merges', expect.objectContaining({ choices: { organization: 'a2' }, versions: { a1: 1, a2: 1 } })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('asks for a field the server names in CHOICE_REQUIRED and shows TOO_MANY_VALUES in place', async () => {
    const onClose = vi.fn();
    render(<QueryClientProvider client={client()}><MergeHost group={duplicateGroup('g', [anna, annaToo])} onClose={onClose} /></QueryClientProvider>);
    const dialog = await screen.findByRole('dialog');
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'Choose which contact\'s value to keep for each field that differs.', status: 400, code: 'CHOICE_REQUIRED', conflicts: ['organization'] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await within(dialog).findByText('Choose a value for each field that differs.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Example Labs' }));
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'Together these contacts have more than 100 phone numbers.', status: 400, code: 'TOO_MANY_VALUES', details: { kinds: ['phone'], kept_properties: false } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await within(dialog).findByText('Together these contacts have more than 100 phone numbers.')).toBeInTheDocument();
    expect(api.post).toHaveBeenLastCalledWith('/contacts/merges', expect.objectContaining({ choices: { organization: 'a1' }, survivor_id: 'a1' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });

  it('closes on VERSION_CONFLICT with a notice that nothing was merged', async () => {
    const onClose = vi.fn();
    render(<QueryClientProvider client={client()}><MergeHost group={duplicateGroup('g', [anna, annaToo])} onClose={onClose} /></QueryClientProvider>);
    const dialog = await screen.findByRole('dialog');
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'These contacts were changed since you looked at them.', status: 409, code: 'VERSION_CONFLICT', contacts: [anna] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'These contacts changed meanwhile' }));
  });

  it('"Not the same person" stores the pair and closes', async () => {
    const onClose = vi.fn();
    render(<QueryClientProvider client={client()}><MergeHost group={duplicateGroup('g', [anna, annaToo])} onClose={onClose} /></QueryClientProvider>);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not the same person' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/contacts/duplicates/dismiss', { contact_ids: ['a1', 'a2'] }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('ContactImportDialog', () => {
  const summary: ImportSummary = {
    id: 'imp1', format: 'vcard3', expires_at: '2026-06-16T09:30:00.000Z',
    counts: { cards: 3, new: 1, present: 1, duplicates: 1 },
    groups: [
      { id: 'g-new', cards: [1], match: 'new', confidence: null, existing_ids: [], reasons: [], conflicts: [], default_decision: 'add' },
      { id: 'g-same', cards: [2], match: 'identical', confidence: null, existing_ids: ['a1'], reasons: [], conflicts: [], default_decision: 'skip' },
      { id: 'g-dup', cards: [3], match: 'duplicate', confidence: 'high', existing_ids: ['a1'], reasons: [{ kind: 'email', detail: 'anna@example.com' }], conflicts: ['organization'], default_decision: 'merge',
        summaries: [{ card: 3, display_name: 'Anna Example', name: { display: null, given: 'Anna', family: 'Example', middle: null, prefix: null, suffix: null },
          organization: { name: 'Example GmbH', department: null }, job_title: null, birthday: null, anniversary: null, emails: ['anna@example.com'], phones: [], has_photo: false }] },
    ],
    warnings: [{ card: 3, property: 'PHOTO', code: 'PHOTO_UNREADABLE', message: 'The photo could not be read and was kept as it is.' }],
    sample_names: ['Anna Example', 'Jürgen Müller'],
  };

  it('shows the summary before writing, applies a bulk decision, and reports the result', async () => {
    vi.mocked(api.uploadBlob).mockResolvedValueOnce({ data: summary });
    vi.mocked(api.post).mockResolvedValueOnce({ data: { id: 'imp1', state: 'committed', progress: 1, expires_at: summary.expires_at, error: null, result: { added: 2, merged: 0, skipped: 1, kept_conflicts: [], warnings: [] } } });
    const onClose = vi.fn();
    render(<QueryClientProvider client={client()}><ContactImportDialog open onClose={onClose} /></QueryClientProvider>);
    const dialog = await screen.findByRole('dialog', { name: 'Import contacts' });
    const file = new File(['BEGIN:VCARD'], 'phone.vcf', { type: 'text/vcard' });
    fireEvent.change(within(dialog).getByLabelText('Choose a file'), { target: { files: [file] } });
    await waitFor(() => expect(api.uploadBlob).toHaveBeenCalledWith('/contacts/imports', file, 'text/vcard'));
    expect(await within(dialog).findByText('vCard 3.0')).toBeInTheDocument();
    expect(within(dialog).getByText(/Jürgen Müller/)).toBeInTheDocument();
    expect(within(dialog).getByText('1 warning')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    // Every match becomes "add" at once; the new card has no decision row.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 3 contacts' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/contacts/imports/imp1/commit', {
      decisions: [{ group_id: 'g-new', decision: 'add' }, { group_id: 'g-same', decision: 'add' }, { group_id: 'g-dup', decision: 'add' }],
    }));
    expect(await within(dialog).findByText('Added')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the cards behind a conflict and resumes a failed import', async () => {
    vi.mocked(api.uploadBlob).mockResolvedValueOnce({ data: summary });
    const failed = { id: 'imp1', state: 'failed', progress: 0.5, expires_at: summary.expires_at, error: { code: 'RESTORE_IN_PROGRESS', message: 'A restore of contacts is running. Import again when it has finished.' },
      result: { added: 1, merged: 0, skipped: 0, kept_conflicts: [], warnings: [{ card: 3, property: 'PHOTO', code: 'PHOTO_TOO_LARGE', message: 'The photo is larger than 20 MB and was not imported' }] } };
    vi.mocked(api.post).mockResolvedValueOnce({ data: failed });
    render(<QueryClientProvider client={client()}><ContactImportDialog open onClose={() => {}} /></QueryClientProvider>);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Choose a file'), { target: { files: [new File(['BEGIN:VCARD'], 'phone.vcf', { type: 'text/vcard' })] } });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Review conflicts (1)' }));
    expect(within(dialog).getByText(/In the file: Anna Example · Example GmbH/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 3 contacts' }));
    expect(await within(dialog).findByText('The import stopped')).toBeInTheDocument();
    expect(within(dialog).getByText(/A restore of contacts is running/)).toBeInTheDocument();
    expect(within(dialog).getByText('So far: 1 added, 0 merged, 0 skipped.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('1 warning'));
    expect(within(dialog).getByText('Contact 3: The photo is larger than 20 MB and was not imported')).toBeInTheDocument();
    vi.mocked(api.post).mockResolvedValueOnce({ data: { ...failed, state: 'committed', progress: 1, error: null, result: { ...failed.result, added: 2 } } });
    fireEvent.click(within(dialog).getByRole('button', { name: /try again/i }));
    expect(await within(dialog).findByText('Added')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it('shows the server refusal of a file and lets another be chosen', async () => {
    vi.mocked(api.uploadBlob).mockResolvedValueOnce({ error: 'The requested API endpoint was not found.', status: 404 });
    render(<QueryClientProvider client={client()}><ContactImportDialog open onClose={() => {}} /></QueryClientProvider>);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Choose a file'), { target: { files: [new File(['x'], 'x.csv', { type: 'text/csv' })] } });
    expect(await within(dialog).findByText('The file could not be read')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Choose file' })).toBeEnabled();
  });
});
