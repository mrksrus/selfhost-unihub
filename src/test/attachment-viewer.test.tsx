import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { saveFile } from '@/lib/platform';
import type { Email, EmailAttachment } from '@/lib/mail-api';
import { MailMessageView } from '@/components/mail/MailMessageView';

const pdf = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { getBlob: vi.fn(), get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/platform', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), saveFile: vi.fn() }));
// jsdom cannot run pdf.js; the viewer's use of it is what is checked here.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: pdf.getDocument,
  TextLayer: class { render() { return Promise.resolve(); } cancel() {} },
}));

const files: Record<string, { attachment: EmailAttachment; body: BlobPart; type: string }> = {
  photo: { attachment: { id: 'photo', filename: 'receipt-photo.jpg', content_type: 'image/jpeg', size_bytes: 2048 }, body: 'jpeg-bytes', type: 'image/jpeg' },
  notes: { attachment: { id: 'notes', filename: 'payment.txt', content_type: 'application/octet-stream', size_bytes: 40 }, body: 'IBAN DE89 3704 0044 0532 0130 00', type: 'application/octet-stream' },
  sheet: { attachment: { id: 'sheet', filename: 'costs.xlsx', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 9000 }, body: 'PK', type: 'application/zip' },
  invoice: { attachment: { id: 'invoice', filename: 'invoice-4711.pdf', content_type: 'application/pdf', size_bytes: 1200 }, body: '%PDF-1.7', type: 'application/pdf' },
};

const email = (attachments: EmailAttachment[]): Email => ({
  id: 'email-1', mail_account_id: 'account-1', subject: 'Invoice 4711', from_address: 'billing@power.example', from_name: 'Power Co',
  to_addresses: ['alex@example.test'], body_text: 'See attached.', body_html: null, folder: 'inbox', is_read: true, is_starred: false,
  received_at: '2026-10-10T08:00:00.000Z', has_attachments: true, attachments,
});

function show(attachments: EmailAttachment[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MailMessageView email={email(attachments)} timezone="UTC" /></QueryClientProvider>);
}
const openRow = (filename: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${filename.replace('.', '\\.')}`) }));

beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:viewer-${++next}`);
  URL.revokeObjectURL = vi.fn();
  vi.mocked(api.getBlob).mockImplementation(async (path: string) => {
    const file = Object.values(files).find(entry => path === `/mail/attachments/${entry.attachment.id}`);
    if (!file) throw Object.assign(new Error('Attachment not found'), { status: 404 });
    return { blob: new Blob([file.body], { type: file.type }), filename: file.attachment.filename };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('attachment viewer', () => {
  it('shows an image in place and downloads the loaded file from the bar', async () => {
    show([files.photo.attachment]);
    openRow('receipt-photo.jpg');
    const dialog = await screen.findByRole('dialog', { name: 'receipt-photo.jpg' });
    expect(await within(dialog).findByRole('img', { name: 'receipt-photo.jpg' })).toHaveAttribute('src', 'blob:viewer-1');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
    expect(saveFile).toHaveBeenCalledWith(expect.any(Blob), 'receipt-photo.jpg');
    expect(api.getBlob).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:viewer-1');
  });

  it('moves between attachments: text by its extension, no preview for a spreadsheet, without fetching twice', async () => {
    show([files.photo.attachment, files.notes.attachment, files.sheet.attachment]);
    openRow('payment.txt');
    const dialog = await screen.findByRole('dialog', { name: 'payment.txt' });
    const text = await within(dialog).findByText('IBAN DE89 3704 0044 0532 0130 00');
    expect(text.tagName).toBe('PRE');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Next attachment' }));
    expect(await screen.findByRole('dialog', { name: 'costs.xlsx' })).toBeInTheDocument();
    expect(await screen.findByText('No preview for this file type')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(await screen.findByRole('dialog', { name: 'payment.txt' })).toBeInTheDocument();
    expect(await screen.findByText('IBAN DE89 3704 0044 0532 0130 00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Previous attachment' }));
    expect(await screen.findByRole('img', { name: 'receipt-photo.jpg' })).toBeInTheDocument();
    expect(vi.mocked(api.getBlob).mock.calls.map(([path]) => path)).toEqual(['/mail/attachments/notes', '/mail/attachments/sheet', '/mail/attachments/photo']);
  });

  it('draws a PDF with pdf.js, counts its pages and draws only those near the view', async () => {
    // jsdom has no layout: the test says which pages are near the visible area.
    let near: (pages: number[]) => void = () => {};
    vi.stubGlobal('IntersectionObserver', class {
      targets: HTMLElement[] = [];
      constructor(callback: IntersectionObserverCallback) {
        near = pages => act(() => callback(this.targets.map(target =>
          ({ target, isIntersecting: pages.includes(Number(target.dataset.page)) }) as unknown as IntersectionObserverEntry), this as unknown as IntersectionObserver));
      }
      observe(target: HTMLElement) { this.targets.push(target); }
      disconnect() {}
    });
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel() {} })),
      streamTextContent: () => new ReadableStream(),
    };
    pdf.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 3, getPage: async () => page }), destroy: vi.fn(async () => {}) });
    show([files.invoice.attachment]);
    openRow('invoice-4711.pdf');
    const dialog = await screen.findByRole('dialog', { name: 'invoice-4711.pdf' });
    expect(await within(dialog).findByText(/Page 1 of 3/)).toBeInTheDocument();
    const [{ data }] = pdf.getDocument.mock.calls[0] as [{ data: Uint8Array }];
    expect(new TextDecoder().decode(data)).toBe('%PDF-1.7');
    const canvasOf = (index: number) => dialog.querySelector(`[data-page="${index}"] canvas`);

    near([0, 1]);
    await waitFor(() => expect(canvasOf(1)).not.toBeNull());
    expect(canvasOf(0)).not.toBeNull();
    expect(canvasOf(2)).toBeNull();
    // Scrolled on: the first page is let go, the last one drawn; scrolled back, the first is drawn again.
    near([1, 2]);
    await waitFor(() => expect(canvasOf(2)).not.toBeNull());
    expect(canvasOf(0)).toBeNull();
    near([0, 1]);
    await waitFor(() => expect(canvasOf(0)).not.toBeNull());
    expect(canvasOf(2)).toBeNull();
    expect(page.render).toHaveBeenCalledTimes(4);
  });
});
