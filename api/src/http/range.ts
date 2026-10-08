interface ByteRange { start: number; end: number }
interface FileValidators { etag: string; lastModified: string }

function parseSingleByteRange(value: unknown, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = String(value || '').trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || requestedEnd < start
    || start >= size
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

// Strong validators from size and modification time, so a browser can resume
// an interrupted download and knows when the file changed in between.
function fileValidators(stat: { mtime?: unknown; size: number } | null | undefined): FileValidators | null {
  const mtime = stat?.mtime instanceof Date ? stat.mtime : null;
  if (!mtime || !Number.isFinite(mtime.getTime()) || !Number.isSafeInteger(stat!.size)) return null;
  return {
    etag: `"${stat!.size.toString(16)}-${Math.floor(mtime.getTime()).toString(16)}"`,
    lastModified: mtime.toUTCString(),
  };
}

// RFC 9110 If-Range: send the range only if the client's copy is the current
// file (strong ETag match or the exact Last-Modified date); otherwise send it all.
function rangeAllowed(ifRange: unknown, validators: FileValidators | null | undefined) {
  if (ifRange === undefined || ifRange === null || ifRange === '') return true;
  if (!validators) return false;
  const value = String(ifRange).trim();
  if (value.startsWith('W/')) return false;
  if (value.startsWith('"')) return value === validators.etag;
  return value === validators.lastModified;
}

export = {
  parseSingleByteRange,
  fileValidators,
  rangeAllowed,
};
