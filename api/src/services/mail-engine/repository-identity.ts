'use strict';
const UINT32_MAX = 4294967295n;
const UINT64_MAX = 18446744073709551615n;
function decimal(value: unknown, max = UINT64_MAX, allowZero = false) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('Unsafe protocol integer');
  if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string') throw new TypeError('Expected decimal integer');
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new RangeError('Invalid protocol integer');
  const n = BigInt(text);
  if (n > max || (!allowZero && n === 0n)) throw new RangeError('Protocol integer out of range');
  return text;
}
function assertUid32(value: unknown) { return Number(decimal(value, UINT32_MAX)); }
function assertDecimal64(value: unknown) { return decimal(value); }
function bool(value: unknown) { return value === true || value === 1 || value === '1'; }
export = { assertUid32, assertDecimal64, bool };
