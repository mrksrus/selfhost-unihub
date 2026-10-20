import type * as PdfJsModule from 'pdfjs-dist';

export type PdfJs = typeof PdfJsModule;

let pdfJs: Promise<PdfJs> | null = null;

/**
 * pdf.js is large, so it loads with the first PDF. It is the legacy build: the
 * modern one calls very new JavaScript (Math.sumPrecise,
 * Map.prototype.getOrInsertComputed, Promise.try, Uint8Array.prototype.toHex)
 * without a fallback, so an Android WebView or browser a few versions behind
 * could not open any PDF.
 */
export function loadPdfJs() {
  pdfJs ??= import('pdfjs-dist/legacy/build/pdf.mjs').then(module => {
    module.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();
    return module as unknown as PdfJs;
  }, (error: unknown) => {
    pdfJs = null;
    throw error;
  });
  return pdfJs;
}

/**
 * Where the build puts pdf.js's JavaScript image decoders (JPEG 2000 and
 * JBIG2, common in scanned documents); see vite.config.ts. The CSP allows no
 * WebAssembly, so pdf.js uses these instead of its .wasm files.
 */
export const PDF_DECODERS_PATH = '/pdfjs/wasm/';

export function pdfDocumentOptions(data: Uint8Array) {
  return { data, useWasm: false, wasmUrl: new URL(PDF_DECODERS_PATH, window.location.origin).toString() };
}

/** The reason pdf.js gave, as one line under "Could not show this PDF". */
export function pdfFailureDetail(error: unknown) {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'PasswordException') return 'The PDF is protected with a password.';
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
