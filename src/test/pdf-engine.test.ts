// @vitest-environment node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// An engine a few versions behind current Chromium, like an Android WebView
// that has not updated: these are missing. The modern pdf.js build calls them
// without a fallback and could not open any PDF there.
const missing: [object, string][] = [
  [Math, 'sumPrecise'],
  [Map.prototype, 'getOrInsertComputed'],
  [WeakMap.prototype, 'getOrInsertComputed'],
  [Promise, 'try'],
  [Uint8Array.prototype, 'toHex'],
  [Uint8Array, 'fromBase64'],
];
const saved = missing.map(([owner, name]) => [owner, name, Object.getOwnPropertyDescriptor(owner, name)] as const);

/** A one-page PDF with a line of text, its cross-reference offsets computed. */
function syntheticPdf(text: string) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.6\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

beforeAll(() => {
  for (const [owner, name] of missing) delete (owner as Record<string, unknown>)[name];
});
afterAll(() => {
  for (const [owner, name, descriptor] of saved) if (descriptor) Object.defineProperty(owner, name, descriptor);
});

describe('the PDF viewer in an older browser engine', () => {
  it('opens a PDF and reads its text with the pdf.js build the viewer loads', async () => {
    expect((Math as { sumPrecise?: unknown }).sumPrecise).toBeUndefined();
    const { loadPdfJs } = await import('@/lib/pdf');
    const pdfjs = await loadPdfJs();
    // The build rewrites the worker URL into an asset; in Node it is the same file, resolved here.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')).href;
    const task = pdfjs.getDocument({ data: syntheticPdf('Invoice 4711'), useWasm: false });
    const document = await task.promise;
    expect(document.numPages).toBe(1);
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    expect(content.items.map(item => ('str' in item ? item.str : '')).join('')).toContain('Invoice 4711');
    await task.destroy();
  });
});
