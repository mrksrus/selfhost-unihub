import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteLockRecords } from '@/lib/app-lock/db';
import { checkPin, PIN_ITERATIONS, pinSupport, readPin, savePin, setPinIterationsForTests, waitAfter } from '@/lib/app-lock/pin';

// The UniHub PIN lives in this browser only (D7): these tests are its whole
// security story, so they use the real WebCrypto and IndexedDB code paths.
// Fewer PBKDF2 rounds keep them fast; the record's own count is the one checked.
beforeAll(() => setPinIterationsForTests(1000));
afterEach(async () => { vi.unstubAllGlobals(); await deleteLockRecords(); });

const at = (time: number) => () => time;

describe('the UniHub PIN', () => {
  it('stores only a salted hash and opens with the right PIN only', async () => {
    await savePin('alex', '482913');
    const record = await readPin('alex');
    expect(record).toMatchObject({ v: 1, userId: 'alex', iterations: 1000, failures: 0, waitUntil: null });
    expect(record!.salt).toHaveLength(16);
    expect(record!.hash).toHaveLength(32);
    expect(JSON.stringify(record)).not.toContain('482913');
    expect(await checkPin('alex', '482913')).toEqual({ result: 'ok' });
    expect(await checkPin('alex', '482914')).toMatchObject({ result: 'wrong', state: { failures: 1, waitUntil: null, attemptsLeft: null } });
  });

  it('takes 6 to 12 digits and counts nothing else', async () => {
    await savePin('alex', '123456789012');
    for (const pin of ['12345', '1234567890123', '12345a', ' 123456', '']) expect(await checkPin('alex', pin)).toEqual({ result: 'invalid' });
    expect((await readPin('alex'))!.failures).toBe(0);
    await expect(savePin('alex', '12345')).rejects.toThrow('6 to 12 digits');
  });

  it('keeps each person’s PIN apart', async () => {
    await savePin('alex', '111111');
    await savePin('blair', '222222');
    expect(await checkPin('alex', '222222')).toMatchObject({ result: 'wrong' });
    expect(await checkPin('blair', '222222')).toEqual({ result: 'ok' });
    expect(await checkPin('casey', '111111')).toEqual({ result: 'no-pin' });
    await deleteLockRecords('blair');
    expect(await readPin('alex')).toBeUndefined();
    expect(await readPin('blair')).toBeDefined();
  });

  it('gives five free tries, then waits that grow, warns from the seventh and signs out at the tenth', async () => {
    let now = 1_000_000;
    const clock = () => now;
    await savePin('alex', '482913');
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await checkPin('alex', '000000', clock)).toMatchObject({ result: 'wrong', state: { failures: attempt, waitUntil: null } });
    }
    const sixth = await checkPin('alex', '000000', clock);
    expect(sixth).toMatchObject({ result: 'wrong', state: { failures: 6, waitUntil: now + 30_000, attemptsLeft: null } });
    // During the wait nothing is checked, not even the right PIN.
    now += 29_000;
    expect(await checkPin('alex', '482913', clock)).toMatchObject({ result: 'wait', state: { failures: 6 } });
    now += 1_000;
    expect(await checkPin('alex', '000000', clock)).toMatchObject({ result: 'wrong', state: { failures: 7, waitUntil: now + 60_000, attemptsLeft: 3 } });
    now += 60_000;
    expect(await checkPin('alex', '000000', clock)).toMatchObject({ result: 'wrong', state: { failures: 8, waitUntil: now + 120_000, attemptsLeft: 2 } });
    now += 120_000;
    expect(await checkPin('alex', '000000', clock)).toMatchObject({ result: 'wrong', state: { failures: 9, waitUntil: now + 240_000, attemptsLeft: 1 } });
    now += 240_000;
    expect(await checkPin('alex', '000000', clock)).toEqual({ result: 'sign-out' });
    // The record is gone: the right PIN no longer opens anything.
    expect(await readPin('alex')).toBeUndefined();
    expect(await checkPin('alex', '482913', clock)).toEqual({ result: 'no-pin' });
  });

  it('the right PIN resets the count', async () => {
    await savePin('alex', '482913');
    for (let attempt = 0; attempt < 4; attempt++) await checkPin('alex', '000000');
    expect(await checkPin('alex', '482913')).toEqual({ result: 'ok' });
    expect(await readPin('alex')).toMatchObject({ failures: 0, waitUntil: null });
  });

  it('counts a try before checking it, so closing the tab mid-check does not undo it', async () => {
    await savePin('alex', '482913');
    const digest = crypto.subtle.deriveBits.bind(crypto.subtle);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'deriveBits').mockImplementationOnce(async (...args) => { await held; return digest(...args); });
    const pending = checkPin('alex', '000000');
    await vi.waitFor(async () => expect((await readPin('alex'))!.failures).toBe(1));
    release();
    expect(await pending).toMatchObject({ result: 'wrong', state: { failures: 1 } });
    vi.restoreAllMocks();
  });

  it('a clock set back does not leave a wait that never ends', async () => {
    let now = 5_000_000;
    await savePin('alex', '482913');
    for (let attempt = 0; attempt < 6; attempt++) await checkPin('alex', '000000', () => now);
    now -= 86_400_000;
    const refused = await checkPin('alex', '482913', () => now);
    expect(refused).toMatchObject({ result: 'wait', state: { waitUntil: now + waitAfter(6) } });
  });

  it('checks a record with the rounds it was made with', async () => {
    setPinIterationsForTests(2000);
    await savePin('alex', '482913');
    setPinIterationsForTests(1000);
    expect((await readPin('alex'))!.iterations).toBe(2000);
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    expect(await checkPin('alex', '482913', at(1))).toEqual({ result: 'ok' });
    expect(derive.mock.calls[0][0]).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: 2000 });
    vi.restoreAllMocks();
    expect(PIN_ITERATIONS).toBe(600_000);
  });

  it('says why a browser without WebCrypto cannot keep a PIN', () => {
    expect(pinSupport()).toEqual({ available: true, reason: null });
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(pinSupport()).toEqual({ available: false, reason: expect.stringContaining('HTTPS') });
  });
});
