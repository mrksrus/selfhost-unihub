function parseSingleByteRange(value, size) {
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

module.exports = {
  parseSingleByteRange,
};
