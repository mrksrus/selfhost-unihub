import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { saveFile } from '@/lib/platform';
import type { Email, EmailAttachment } from '@/lib/mail-api';
import { MailMessageView } from '@/components/mail/MailMessageView';

const pdf = vi.hoisted(() => ({ getDocument: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => ({ api: { getBlob: vi.fn(), get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/platform', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), saveFile: vi.fn(async () => {}) }));
// jsdom cannot run pdf.js; the viewer's use of it is what is checked here.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: pdf.getDocument,
  TextLayer: class { render() { return Promise.resolve(); } cancel() {} },
}));

const files: Record<string, { attachment: EmailAttachment; body: BlobPart; type: string }> = {
  photo: { attachment: { id: 'photo', filename: 'receipt-photo.jpg', content_type: 'image/jpeg', size_bytes: 2048 }, body: 'jpeg-bytes', type: 'image/jpeg' },
  notes: { attachment: { id: 'notes', filename: 'payment.txt', content_type: 'application/octet-stream', size_bytes: 40 }, body: 'IBAN DE89 3704 0044 0532 0130 00', type: 'application/octet-stream' },
  sheet: { attachment: { id: 'sheet', filename: 'costs.xlsx', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 9000 }, body: 'PK', type: 'application/zip' },
  invoice: { attachment: { id: 'invoice', filename: 'invoice-4711.pdf', content_type: 'application/pdf', size_bytes: 1200 }, body: '%PDF-1.7', type: 'application/pdf' },
  logo: { attachment: { id: 'logo', filename: 'logo.svg', content_type: 'image/svg+xml', size_bytes: 300 }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/auth/me")</script></svg>', type: 'image/svg+xml' },
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

  it('draws an SVG from a data: URL, never from a same-origin blob: URL, and offers no new tab for it', async () => {
    show([files.logo.attachment, files.photo.attachment]);
    openRow('logo.svg');
    const dialog = await screen.findByRole('dialog', { name: 'logo.svg' });
    const image = await within(dialog).findByRole('img', { name: 'logo.svg' });
    expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole('link', { name: 'Open in new tab' })).not.toBeInTheDocument();

    // Raster images keep the object URL and the new-tab link.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next attachment' }));
    const photo = await screen.findByRole('dialog', { name: 'receipt-photo.jpg' });
    expect(await within(photo).findByRole('img', { name: 'receipt-photo.jpg' })).toHaveAttribute('src', 'blob:viewer-1');
    expect(within(photo).getByRole('link', { name: 'Open in new tab' })).toBeInTheDocument();
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
    const [{ data, ...options }] = pdf.getDocument.mock.calls[0] as [{ data: Uint8Array }];
    expect(new TextDecoder().decode(data)).toBe('%PDF-1.7');
    // The CSP allows no WebAssembly: the image decoders are the JavaScript ones the build ships.
    expect(options).toEqual({ useWasm: false, wasmUrl: `${window.location.origin}/pdfjs/wasm/` });
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

  it('says why a PDF could not be shown, and still offers the download', async () => {
    pdf.getDocument.mockReturnValue({ promise: Promise.reject(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' })), destroy: vi.fn(async () => {}) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    show([files.invoice.attachment]);
    openRow('invoice-4711.pdf');
    const dialog = await screen.findByRole('dialog', { name: 'invoice-4711.pdf' });
    expect(await within(dialog).findByText('Could not show this PDF')).toBeInTheDocument();
    expect(within(dialog).getByText('InvalidPDFException: Invalid PDF structure.')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: /Download/ }).length).toBeGreaterThan(0);
  });
});

describe('attachment viewer in the Android app', () => {
  const APP = 'Mozilla/5.0 (Linux; Android 16; wv) Chrome/140.0 Mobile UniHubAndroid/0.25.0 (25000)';
  let posted: Record<string, unknown>[];
  let reply: ((event: { data: string }) => void) | null;
  beforeEach(() => {
    posted = [];
    reply = null;
    // The PDF stays loading: these tests are about the bar.
    pdf.getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy: async () => {} });
    window.UniHubAndroid = {
      postMessage: (message: string) => { posted.push(JSON.parse(message)); },
      addEventListener: (_type, listener) => { reply = listener; },
    };
    vi.mocked(api.post).mockResolvedValue({ data: { url: '/api/files/tickets/T0k3n', expires_at: '2026-10-28T10:01:00.000Z', filename: 'invoice-4711.pdf', content_type: 'application/pdf', size: 1200 } });
  });
  afterEach(() => { delete window.UniHubAndroid; vi.restoreAllMocks(); });

  it('opens, saves and shares through Android with a download ticket, never the loaded file', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(`${APP} UniHubBridge/2`);
    show([files.invoice.attachment]);
    openRow('invoice-4711.pdf');
    const dialog = await screen.findByRole('dialog', { name: 'invoice-4711.pdf' });
    expect(within(dialog).queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();

    for (const [label, action] of [['Share', 'share'], ['Save to Downloads', 'save'], ['Open with…', 'open']] as const) {
      fireEvent.click(within(dialog).getByRole('button', { name: label }));
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(api.post).toHaveBeenLastCalledWith('/files/tickets', { kind: 'mail-attachment', id: 'invoice' });
      const [message] = posted.splice(0);
      expect(message).toMatchObject({ type: 'fileAction', action, url: `${window.location.origin}/api/files/tickets/T0k3n`, name: 'invoice-4711.pdf', mime: 'application/pdf' });
      // One action at a time, until the app answers.
      expect(within(dialog).getByRole('button', { name: 'Share' })).toBeDisabled();
      act(() => reply?.({ data: JSON.stringify({ id: message.id, ok: true }) }));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Share' })).toBeEnabled());
    }
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('says so when the app could not get the file', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(`${APP} UniHubBridge/2`);
    show([files.invoice.attachment]);
    openRow('invoice-4711.pdf');
    const dialog = await screen.findByRole('dialog', { name: 'invoice-4711.pdf' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    act(() => reply?.({ data: JSON.stringify({ id: posted[0].id, ok: false, error: 'This download link has expired or was already used. Try again from UniHub.' }) }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'This download link has expired or was already used. Try again from UniHub.', variant: 'destructive' })));
  });

  it('keeps Download in an app from before 0.25, whose bridge has no file actions', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 16; wv) UniHubAndroid/0.24.3 (24003)');
    show([files.invoice.attachment]);
    openRow('invoice-4711.pdf');
    const dialog = await screen.findByRole('dialog', { name: 'invoice-4711.pdf' });
    expect(within(dialog).getAllByRole('button', { name: 'Download' }).length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
  });
});
