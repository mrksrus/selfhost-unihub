// @vitest-environment node
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatDeviceEnrolRequest } from '../../api/src/contracts/chat';
import { api } from '@/lib/api';
import { concat, fromBase64Url, toBase64Url } from '@/lib/chat/bytes';
import { ChatDevice, enrol, startDevice } from '@/lib/chat/device';
import { createHistoryKey, unwrapHistoryKey, wrapHistoryKey, WrongPassphraseError } from '@/lib/chat/key-backup';
import { loadMls } from '@/lib/chat/mls';
import { createSealKey, open, seal } from '@/lib/chat/seal';
import { ChatStore, wipeChatStore } from '@/lib/chat/store';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

describe('sealing (RFC 8291) and the key backup', () => {
  // The example of RFC 8291 section 5.
  const receiverPublic = fromBase64Url('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
  const rfcMessage = fromBase64Url('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const rfcKey = async () => ({
    privateKey: await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
      x: toBase64Url(receiverPublic.slice(1, 33)), y: toBase64Url(receiverPublic.slice(33)),
    }, P256, false, ['deriveBits']),
    publicKey: receiverPublic,
    auth: fromBase64Url('BTBZMqHH6r4Tts7J_aSIgg'),
  });

  it('opens the RFC\'s example, opens what it seals, and refuses a changed or misdirected message', async () => {
    const key = await rfcKey();
    expect(decode(await open(key, rfcMessage))).toBe('When I grow up, I want to be a watermelon');

    const sender = await crypto.subtle.generateKey(P256, false, ['deriveBits']);
    const signed = await seal(key, encode('from a known sender'), sender);
    expect(signed.slice(21, 86)).toEqual(new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey)));
    expect(decode(await open(key, signed))).toBe('from a known sender');
    const sealed = await seal(key, encode('hello'));
    expect(decode(await open(key, sealed))).toBe('hello');

    // The RFC's sender key, reused: its second message comes from the kept key agreement and is still the RFC's message.
    const senderPublic = rfcMessage.slice(21, 86);
    const rfcSender = {
      privateKey: await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
        x: toBase64Url(senderPublic.slice(1, 33)), y: toBase64Url(senderPublic.slice(33)) }, P256, false, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', senderPublic, P256, true, []),
    };
    const salt = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => { (array as Uint8Array).set(rfcMessage.slice(0, 16)); return array; });
    try {
      for (let time = 0; time < 2; time++) expect(await seal(key, encode('When I grow up, I want to be a watermelon'), rfcSender)).toEqual(rfcMessage);
    } finally {
      salt.mockRestore();
    }

    sealed[sealed.length - 1] ^= 1;
    await expect(open(key, sealed)).rejects.toThrow();
    await expect(open(await createSealKey(false), rfcMessage)).rejects.toThrow();
  });

  it('opens the history key with the right passphrase only, in any Unicode form', async () => {
    const key = await createHistoryKey();
    const passphrase = 'café au lait at nine';
    const account = { history_public: toBase64Url(key.publicKey), key_backup: await wrapHistoryKey(key, passphrase), updated_at: '' };
    const copy = await seal(key, encode('an archived message'));

    await expect(unwrapHistoryKey(account, 'cafe au lait at nine')).rejects.toBeInstanceOf(WrongPassphraseError);
    const opened = await unwrapHistoryKey(account, passphrase.normalize('NFD'));
    expect(decode(await open(opened, copy))).toBe('an archived message');
    await expect(wrapHistoryKey(key, 'eleven char')).rejects.toThrow('at least 12');
  });
});

describe('the device store', () => {
  it('stores a step whole or not at all, and a wipe leaves nothing', async () => {
    const store = await ChatStore.open('store-alex');
    const entry = { key: encode('state-1'), value: encode('first') };
    const message = { id: 'm-1', conversation_id: 'c-1', seq: 1 };
    await store.write([entry], transaction => { transaction.objectStore('messages').put(message); });

    await expect(store.write([{ key: entry.key, value: encode('second') }], transaction => {
      transaction.objectStore('messages').put({ ...message, id: 'm-2', seq: 2 });
      throw new Error('the step failed');
    })).rejects.toThrow('the step failed');
    // Refused by the browser after the step's own code ran: a second message with the same id.
    await expect(store.write([{ key: entry.key }], transaction => { transaction.objectStore('messages').add(message); })).rejects.toThrow();
    expect(await store.state()).toEqual([entry]);
    expect(await store.all('messages')).toEqual([message]);

    store.close();
    await wipeChatStore('store-alex');
    const again = await ChatStore.open('store-alex');
    expect(await again.state()).toEqual([]);
    expect(await again.all('messages')).toEqual([]);
    again.close();
  });
});

// The module is built only where its Rust tool chain is (CI and the image); CI must have it.
const built = path.resolve(__dirname, '../lib/chat/mls-module/chat_mls_bg.wasm');

describe.skipIf(!existsSync(built) && !process.env.CI)('devices through Chat\'s MLS module', () => {
  beforeAll(() => loadMls(readFileSync(built)));
  const group = encode('group-1');
  const enrolments = new Map<string, ChatDeviceEnrolRequest>();

  /** Enrols `name` (a person and a device number, "blair-2") in a store of its own; the server is mocked. */
  async function enrolAs(name: string) {
    vi.mocked(api.post).mockImplementationOnce(async (_path, body) => {
      enrolments.set(name, body as ChatDeviceEnrolRequest);
      return { data: { chat_device_id: name, key_packages: 100 } } as never;
    });
    const store = await ChatStore.open(name);
    return { store, device: await enrol(store, name.split('-')[0]) };
  }

  /** Alex's device makes a group with `others`, each from the first key package it enrolled with. */
  async function groupOf(alex: ChatDevice, others: { device: ChatDevice }[]) {
    const packages = others.map(other => fromBase64Url(enrolments.get(other.device.id!)!.key_packages[0]));
    const welcome = await alex.step(mls => mls.create_group(group, concat(...packages)));
    for (const other of others) expect(decode(await other.device.step(mls => mls.join(welcome)))).toBe('group-1');
    return welcome;
  }

  it('three devices of two people write to each other, and a device outside the group reads nothing', async () => {
    const [alex, blair, blair2, casey] = [await enrolAs('alex-1'), await enrolAs('blair-1'), await enrolAs('blair-2'), await enrolAs('casey-1')];
    const enrolled = enrolments.get('alex-1')!;
    expect(enrolled.key_packages).toHaveLength(100);
    expect(enrolled.last_resort).toBeTruthy();
    expect(fromBase64Url(enrolled.preview!.p256dh)).toHaveLength(65);

    const welcome = await groupOf(alex.device, [blair, blair2]);
    expect((await blair2.device.step(mls => mls.members(group))).sort()).toEqual([alex.device.name, blair.device.name, blair2.device.name].sort());
    const hello = await alex.device.step(mls => mls.encrypt(group, encode('hello')));
    for (const { device } of [blair, blair2]) expect(decode(await device.step(mls => mls.decrypt(group, hello)))).toBe('hello');
    const reply = await blair2.device.step(mls => mls.encrypt(group, encode('hi alex')));
    for (const { device } of [alex, blair]) expect(decode(await device.step(mls => mls.decrypt(group, reply)))).toBe('hi alex');

    await expect(casey.device.step(mls => mls.join(welcome))).rejects.toMatchObject({ kind: 'refused' });
    await expect(casey.device.step(mls => mls.decrypt(group, hello))).rejects.toMatchObject({ kind: 'unknown-group' });
  });

  it('a device goes on after its store is opened again and after the module started again', async () => {
    const [alex, blair] = [await enrolAs('alex-2'), await enrolAs('blair-3')];
    await groupOf(alex.device, [blair]);

    blair.store.close();
    const store = await ChatStore.open('blair-3');
    vi.mocked(api.get).mockResolvedValueOnce({ data: { chat_device_id: 'blair-3', key_packages: 97 } } as never);
    vi.mocked(api.post).mockClear().mockResolvedValueOnce({ data: { chat_device_id: 'blair-3', key_packages: 100 } } as never);
    let reopened = await startDevice(store, 'blair');
    expect(reopened.name).toBe(blair.device.name);
    expect(vi.mocked(api.post).mock.calls[0][1]).toEqual({ key_packages: [expect.any(String), expect.any(String), expect.any(String)] });
    const later = await alex.device.step(mls => mls.encrypt(group, encode('after the reload')));
    expect(decode(await reopened.step(mls => mls.decrypt(group, later)))).toBe('after the reload');

    // As after a trap: every device in the module is gone and comes back from its store.
    (await import('@/lib/chat/mls-module/chat_mls.js' as string)).__wbg_reset_state();
    const alexAgain = (await ChatDevice.open(alex.store))!;
    reopened = (await ChatDevice.open(store))!;
    const back = await reopened.step(mls => mls.encrypt(group, encode('after the restart')));
    expect(decode(await alexAgain.step(mls => mls.decrypt(group, back)))).toBe('after the restart');
  });

  it('a failed step and a tampered message leave the stored state as it was and cost only themselves', async () => {
    const [alex, blair] = [await enrolAs('alex-3'), await enrolAs('blair-4')];
    await groupOf(alex.device, [blair]);
    const before = await blair.store.state();

    await expect(blair.device.step(mls => mls.key_package(false), () => { throw new Error('the disk is full'); })).rejects.toThrow('the disk is full');
    expect(await blair.store.state()).toEqual(before);

    const genuine = await alex.device.step(mls => mls.encrypt(group, encode('genuine')));
    const tampered = genuine.slice();
    tampered[tampered.length - 1] ^= 1;
    const keep = (transaction: IDBTransaction) => { transaction.objectStore('messages').put({ id: 'm-1', conversation_id: 'c-1', seq: 1 }); };
    await expect(blair.device.step(mls => mls.decrypt(group, tampered), keep)).rejects.toMatchObject({ kind: 'refused' });
    expect(await blair.store.state()).toEqual(before);
    expect(await blair.store.all('messages')).toEqual([]);
    expect(decode(await blair.device.step(mls => mls.decrypt(group, genuine), keep))).toBe('genuine');
    const next = await alex.device.step(mls => mls.encrypt(group, encode('next')));
    expect(decode(await blair.device.step(mls => mls.decrypt(group, next)))).toBe('next');
  });

  it('a device the server no longer knows is enrolled again', async () => {
    const blair = await enrolAs('blair-5');
    vi.mocked(api.get).mockResolvedValueOnce({ error: 'Not enrolled', status: 404, code: 'CHAT_DEVICE_NOT_ENROLLED' } as never);
    vi.mocked(api.post).mockResolvedValueOnce({ data: { chat_device_id: 'blair-6', key_packages: 100 } } as never);
    const again = await startDevice(blair.store, 'blair');
    expect(again.id).toBe('blair-6');
    expect(again.name).not.toBe(blair.device.name);
  });
});
