// Escapes a search term for a parameterized LIKE so `%`, `_` and `\` match
// themselves; the caller adds the surrounding wildcards. One copy, because a
// route that forgets a character turns a typed `%` into "match everything".
function escapeLike(value: unknown) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export { escapeLike };
