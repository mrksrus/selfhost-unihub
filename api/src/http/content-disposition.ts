// The Content-Disposition of a download: an ASCII filename for old clients
// and the RFC 5987 UTF-8 form, never a header break. Used by the request
// boundary and by routes that write their own (streamed) response.
function sanitizeHeaderFilename(filename: unknown) {
  const sanitized = String(filename || 'download')
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim();
  return sanitized || 'download';
}

function buildContentDisposition(dispositionType: unknown, filename: unknown) {
  const safeDispositionType = dispositionType === 'inline' ? 'inline' : 'attachment';
  const rawFilename = String(filename || 'download').replace(/[\r\n]/g, ' ').trim() || 'download';
  const safeFilename = sanitizeHeaderFilename(rawFilename);
  const encodedFilename = encodeURIComponent(rawFilename);
  return `${safeDispositionType}; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;
}

export { buildContentDisposition };
