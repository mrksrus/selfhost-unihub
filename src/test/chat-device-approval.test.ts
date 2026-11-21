// @vitest-environment node
import { ALEX, BLAIR, PASSPHRASES, open, pair, send, server, settled, tab, texts, until, chatDeliveryHooks, type Tab } from './chat-delivery';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '@/lib/chat/bytes';
import { WrongPassphraseError } from '@/lib/chat/key-backup';
import { createSealKey } from '@/lib/chat/seal';

// A new chat device joins no chat until the passphrase, an approval from another
// device of the same person, or the proof of a history key it still holds; in
// the engine, against the in-memory delivery service and its waiting rule.

chatDeliveryHooks();
afterEach(() => { vi.useRealTimers(); });

const own = (userId: string, device: string) => [...server.devices.values()].find(item => item.device === `${userId}:${device}`)!;
const state = (on: Tab) => on.engine.snapshot().readiness.state;
const named = (device: string) => ({ id: device, kind: 'web', app_version: null, user_agent: null });

describe('joining Chat on a device', { timeout: 60_000 }, () => {
  it('a person\'s first device waits until the passphrase sets Chat up, and can be written to from then on', async () => {
    const alex = open(ALEX, 'a1');
    await settled(alex);
    await alex.as(engine => engine.choosePassphrase(PASSPHRASES[ALEX]));
    const blair = open(BLAIR, 'b1');
    await settled(blair);
    expect(blair.engine.snapshot().readiness).toEqual({ state: 'choose-passphrase' });
    expect(own(BLAIR, 'b1').joined).toBe(false);
    const conversation = await alex.as(engine => engine.openConversation(BLAIR));
    await alex.as(engine => engine.sync());
    expect(alex.engine.snapshot().conversations[0].peer.can_write).toBe(false);

    await blair.as(engine => engine.choosePassphrase(PASSPHRASES[BLAIR]));
    expect(blair.engine.snapshot().readiness).toEqual({ state: 'ready' });
    expect(own(BLAIR, 'b1').joined).toBe(true);
    await alex.as(engine => engine.sync());
    expect(alex.engine.snapshot().conversations[0].peer.can_write).toBe(true);
    await send(alex, conversation, 'welcome to chat');
    await blair.as(engine => engine.sync());
    expect(texts(blair, conversation)).toEqual(['welcome to chat']);
  });

  it('a second device reads and sends nothing while it waits; approved by the code, every tab joins with the history and no passphrase', async () => {
    const { alex, blair, conversation } = await pair();
    await send(alex, conversation, 'before the new browser');
    const blair2 = open(BLAIR, 'b2');
    const otherTab = tab(blair2.browser);
    await until(blair2, engine => engine.snapshot().readiness.state === 'waiting');
    await blair2.as(engine => engine.sync());
    expect(blair2.engine.snapshot().readiness).toEqual({ state: 'waiting', approvers: [named(`${BLAIR}:b1`)], code: null });

    await send(alex, conversation, 'while it waits');
    expect([...[...server.groups.values()].at(-1)!.devices.keys()]).not.toContain(own(BLAIR, 'b2').id);
    expect(blair2.engine.snapshot().conversations).toEqual([]);
    await expect(blair2.as(engine => engine.openConversation(ALEX))).rejects.toMatchObject({ code: 'CHAT_DEVICE_WAITING' });
    await blair.as(engine => engine.sync());

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await blair2.as(engine => engine.askApproval());
    const asked = blair2.engine.snapshot().readiness;
    expect(asked).toMatchObject({ state: 'waiting', code: expect.stringMatching(/^\d{6}$/) });
    await blair.as(engine => engine.sync());
    expect(blair.engine.snapshot().approvals).toEqual([{ chat_device_id: own(BLAIR, 'b2').id, device: named(`${BLAIR}:b2`), requested_at: expect.any(String),
      code: (asked as { code: string }).code, signed_in_at: '2026-01-02T03:04:05.000Z' }]);
    await blair.as(engine => engine.approve(own(BLAIR, 'b2').id));
    expect(blair.engine.snapshot().approvals).toEqual([]);

    // No hint reaches this service: the waiting device finds the answer at its interval (run as that browser, which fake timers do not carry).
    await blair2.as(() => vi.advanceTimersByTimeAsync(10_000));
    await until(blair2, engine => engine.snapshot().readiness.state === 'ready' && engine.snapshot().holds_history_key && !engine.snapshot().restore);
    await until(otherTab, engine => engine.snapshot().readiness.state === 'ready' && engine.snapshot().holds_history_key);
    await send(alex, conversation, 'after the approval');
    await blair2.as(engine => engine.sync());
    expect(texts(blair2, conversation)).toEqual(['before the new browser', 'while it waits', 'after the approval']);
  });

  it('a history key sealed to another one-time key is not taken, and the codes differ', async () => {
    const { blair } = await pair();
    const blair2 = open(BLAIR, 'b2');
    await until(blair2, engine => engine.snapshot().readiness.state === 'waiting');
    await blair2.as(engine => engine.askApproval());
    const shown = (blair2.engine.snapshot().readiness as { code: string }).code;
    // The server hands Blair's first browser a key of its own in place of the asking device's.
    own(BLAIR, 'b2').pair!.public_key = toBase64Url((await createSealKey(false)).publicKey);
    await blair.as(engine => engine.sync());
    expect(blair.engine.snapshot().approvals[0].code).not.toBe(shown);
    await blair.as(engine => engine.approve(own(BLAIR, 'b2').id));
    await blair2.as(engine => engine.sync());
    expect(blair2.engine.snapshot()).toMatchObject({ readiness: { state: 'enter-passphrase' }, holds_history_key: false });
  });

  it('a wrong passphrase proves nothing; the right one joins and brings the history', async () => {
    const { alex, blair, conversation } = await pair();
    await send(alex, conversation, 'earlier');
    await blair.as(engine => engine.sync());
    const blair2 = open(BLAIR, 'b2');
    await until(blair2, engine => engine.snapshot().readiness.state === 'waiting');
    await expect(blair2.as(engine => engine.enterPassphrase('not the chat passphrase'))).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(own(BLAIR, 'b2').joined).toBe(false);
    expect(state(blair2)).toBe('waiting');
    await blair2.as(engine => engine.enterPassphrase(PASSPHRASES[BLAIR]));
    expect(own(BLAIR, 'b2').joined).toBe(true);
    expect(blair2.engine.snapshot().readiness).toEqual({ state: 'ready' });
    await blair2.as(engine => engine.sync());
    expect(texts(blair2, conversation)).toEqual(['earlier']);
  });

  it('a device whose store holds the history key joins at its start with nothing asked', async () => {
    const { blair } = await pair();
    // As after an instance restore: the server knows no chat device of this browser; its store is intact.
    own(BLAIR, 'b1').device = null;
    blair.engine.stop();
    const again = tab(blair.browser);
    await until(again, engine => engine.snapshot().readiness.state === 'ready' && !!own(BLAIR, 'b1')?.joined);
    expect(again.engine.snapshot().holds_history_key).toBe(true);

    // A refusal for a device the store holds as joined says it waits, and it proves itself again.
    own(BLAIR, 'b1').joined = false;
    await again.as(engine => engine.sync());
    await until(again, () => own(BLAIR, 'b1').joined);
    expect(state(again)).toBe('ready');
  });

  it('a device joined without the history key cannot approve; a new key is refused while another device is in Chat', async () => {
    const { blair } = await pair();
    const before = open(BLAIR, 'b2');
    await until(before, engine => engine.snapshot().readiness.state === 'waiting');
    // A device from before devices waited, which never took the passphrase.
    own(BLAIR, 'b2').joined = true;
    await before.as(engine => engine.sync());
    expect(before.engine.snapshot()).toMatchObject({ readiness: { state: 'enter-passphrase' }, holds_history_key: false });

    const blair3 = open(BLAIR, 'b3');
    await until(blair3, engine => engine.snapshot().readiness.state === 'waiting');
    await blair3.as(engine => engine.askApproval());
    await before.as(engine => engine.sync());
    expect(before.engine.snapshot().approvals).toEqual([]);
    await expect(before.as(engine => engine.approve(own(BLAIR, 'b3').id))).rejects.toThrow(/history key/);
    expect(own(BLAIR, 'b3').joined).toBe(false);

    await expect(blair3.as(engine => engine.startNewKey('account password', 'a new chat passphrase'))).rejects.toMatchObject({ code: 'CHAT_DEVICE_SIGNED_IN' });
    expect(blair3.engine.snapshot().new_key_refused).toEqual([named(`${BLAIR}:b1`), named(`${BLAIR}:b2`)]);
    for (const device of ['b1', 'b2']) own(BLAIR, device).device = null;
    blair.engine.stop();
    await blair3.as(engine => engine.startNewKey('account password', 'a new chat passphrase'));
    expect(blair3.engine.snapshot()).toMatchObject({ readiness: { state: 'ready' }, holds_history_key: true, new_key_refused: null });
  });
});
