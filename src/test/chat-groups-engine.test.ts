// @vitest-environment node
import { ALEX, BLAIR, context, message, open, send, server, settled, tab, texts, until, chatDeliveryHooks, type Tab } from './chat-delivery';
import { describe, expect, it } from 'vitest';
import { fromBase64Url } from '@/lib/chat/bytes';
import { open as openSealed, type SealKey } from '@/lib/chat/seal';
import { ChatStore } from '@/lib/chat/store';
import type { ChatThreadMessage, ChatThreadNotice } from '@/lib/chat/types';

// Group chats in the engine, against the in-memory delivery service.

chatDeliveryHooks();

const CASEY = 'casey';
const DREW = 'drew';

/** A person's first browser with a passphrase chosen. */
async function person(userId: string, device: string) {
  server.names.set(CASEY, 'Casey Example').set(DREW, 'Drew Example');
  const on = open(userId, device);
  await settled(on);
  await on.as(engine => engine.choosePassphrase(`${userId} chat passphrase`));
  return on;
}

const syncAll = async (...devices: Tab[]) => { for (const on of devices) await on.as(engine => engine.sync()); };
const lines = (on: Tab, id: string) => (on.engine.thread(id) ?? []).filter((item): item is ChatThreadNotice => item.kind !== 'message' && item.kind !== 'call').map(item => `${item.name} ${item.kind}`);
const own = (userId: string, device: string) => [...server.devices.values()].find(item => item.device === `${userId}:${device}`)!;

/** Alex's group chat with Blair and Casey. */
async function planning(...devices: Tab[]) {
  const [alex] = devices;
  const chat = await alex.as(engine => engine.createGroup('Planning', { user_ids: [BLAIR, CASEY] }));
  await syncAll(...devices);
  return chat;
}

describe('the chat engine in group chats', { timeout: 120_000 }, () => {
  it('three people write on five devices with mentions and receipts; Drew reads from his joining on; removed Casey keeps nothing', async () => {
    const [alex, blair, casey] = [await person(ALEX, 'a1'), await person(BLAIR, 'b1'), await person(CASEY, 'c1')];
    const [alex2, blair2] = [open(ALEX, 'a2'), open(BLAIR, 'b2')];
    await Promise.all([settled(alex2), settled(blair2)]);
    for (const [on, userId] of [[alex2, ALEX], [blair2, BLAIR]] as const) await on.as(engine => engine.enterPassphrase(`${userId} chat passphrase`));
    const everyone = [alex, alex2, blair, blair2, casey];
    const chat = await planning(...everyone);

    alex.as(engine => engine.send(chat, 'Hello @Blair Example and everyone', null, [BLAIR]));
    await until(alex, () => message(alex, chat, 'Hello @Blair Example and everyone')?.delivery === 'sent');
    await send(blair2, chat, 'hi from my second browser');
    await send(casey, chat, 'hi from casey');
    await syncAll(...everyone);
    for (const on of everyone) expect(texts(on, chat)).toEqual(['Hello @Blair Example and everyone', 'hi from my second browser', 'hi from casey']);
    const hello = message(blair, chat, 'Hello @Blair Example and everyone')!;
    expect(hello).toMatchObject({ sender_name: 'Alex Example', mentions: [BLAIR], mentions_me: true, former_colleague: false });
    expect(message(casey, chat, hello.text!)?.mentions_me).toBe(false);
    expect(server.posts.get(hello.id)?.mentions).toEqual([BLAIR]);
    expect(blair.engine.snapshot().conversations[0]).toMatchObject({ kind: 'group', name: 'Planning', mentioned: true, group: { role: 'member', member_count: 3 } });
    blair.as(engine => engine.markRead(chat));
    expect(blair.engine.snapshot().conversations[0].mentioned).toBe(false);

    // The previews of a page share one sender key, and each opens with the receiving browser's preview key.
    await send(alex, chat, 'a second message');
    const previews = [hello.id, message(alex, chat, 'a second message')!.id].flatMap(id => server.posts.get(id)!.previews);
    expect(previews.map(item => item.chat_device_id).sort()).toEqual([own(BLAIR, 'b1'), own(BLAIR, 'b2'), own(CASEY, 'c1')].flatMap(device => [device.id, device.id]).sort());
    expect(new Set(previews.map(item => fromBase64Url(item.sealed).slice(21, 86).join())).size).toBe(1);
    const previewKey = await context.run(blair.browser, async () => (await ChatStore.open(BLAIR)).get<SealKey>('keys', 'preview'));
    expect(new TextDecoder().decode(await openSealed(previewKey!, fromBase64Url(previews.find(item => item.chat_device_id === own(BLAIR, 'b1').id)!.sealed))))
      .toBe('Hello @Blair Example and everyone');

    // Read by the people with receipts on, once the members are known.
    casey.as(engine => engine.markRead(chat));
    await syncAll(blair, casey, alex);
    expect(message(alex, chat, hello.text!)?.read_by).toEqual({ people: [{ user_id: BLAIR, name: 'Blair Example' }, { user_id: CASEY, name: 'Casey Example' }], of: 2 });
    expect(message(alex, chat, 'a second message')?.read_by).toEqual({ people: [], of: 2 });

    // Drew is added: the chat shows at once, and he reads from the next group on.
    await alex.as(engine => engine.addMembers(chat, [DREW]));
    const drew = await person(DREW, 'd1');
    await send(alex, chat, 'welcome drew');
    await syncAll(drew, blair);
    expect(texts(drew, chat)).toEqual(['welcome drew']);
    expect(lines(blair, chat)).toEqual(['Drew Example joined']);

    // Casey is removed: her browser drops the chat and its messages, and is in no later group.
    // Blair's second browser was reloaded after it, and still names her.
    await alex.as(engine => engine.removeMember(chat, CASEY));
    blair2.engine.stop();
    const reloaded = tab(blair2.browser);
    await settled(reloaded);
    await send(alex, chat, 'after casey left');
    await syncAll(casey, blair, reloaded);
    expect(lines(reloaded, chat)).toEqual(['Drew Example joined', 'Casey Example left']);
    expect(casey.engine.snapshot().conversations).toEqual([]);
    expect(casey.engine.thread(chat)).toEqual([]);
    expect(casey.engine.search('hi')).toEqual([]);
    expect(await context.run(casey.browser, async () => (await ChatStore.open(CASEY)).all('messages'))).toEqual([]);
    expect(server.groups.get(server.conversations.get(chat)!.current!)!.devices.has(own(CASEY, 'c1').id)).toBe(false);
    expect(texts(blair, chat).at(-1)).toBe('after casey left');
    expect(lines(blair, chat)).toEqual(['Drew Example joined', 'Casey Example left']);

    // Search on this device: a chat by its name, a message by a word.
    expect(blair.engine.search('PLAN')).toMatchObject([{ conversation_id: chat, message_id: null, line: 'Planning', match: [0, 4] }]);
    expect(blair.engine.search('second')).toMatchObject([
      { message_id: message(blair, chat, 'a second message')!.id, sender_name: 'Alex Example', chat_name: 'Planning', match: [2, 8] },
      { message_id: message(blair, chat, 'hi from my second browser')!.id, sender_name: 'Blair Example', line: 'hi from my second browser' },
    ]);
  });

  it('two people who make the first group at once converge', async () => {
    const [alex, blair, casey] = [await person(ALEX, 'a1'), await person(BLAIR, 'b1'), await person(CASEY, 'c1')];
    const chat = await planning(alex, blair, casey);
    let opened!: () => void;
    server.state.groupGate = { waiting: 0, size: 2, open: () => opened(), opened: new Promise(resolve => { opened = resolve; }) };
    blair.as(engine => engine.send(chat, 'blair first'));
    casey.as(engine => engine.send(chat, 'casey first'));
    await Promise.all([until(blair, () => message(blair, chat, 'blair first')?.delivery === 'sent'), until(casey, () => message(casey, chat, 'casey first')?.delivery === 'sent')]);
    server.state.groupGate = null;
    expect(server.groups.size).toBe(1);
    await syncAll(alex, blair, casey);
    for (const on of [alex, blair, casey]) expect(texts(on, chat).sort()).toEqual(['blair first', 'casey first']);
  });

  it('a device away for ten groups catches them up in order', async () => {
    const [alex, blair, casey] = [await person(ALEX, 'a1'), await person(BLAIR, 'b1'), await person(CASEY, 'c1')];
    const spare = open(BLAIR, 'b2');
    await settled(spare);
    await spare.as(engine => engine.enterPassphrase(`${BLAIR} chat passphrase`));
    spare.engine.stop();
    const chat = await planning(alex, blair, casey);
    await send(alex, chat, 'before');
    await syncAll(casey);
    // Blair's spare browser comes and goes: every message goes to a new group.
    const sent = Array.from({ length: 10 }, (_, index) => `away ${index + 1}`);
    const b2 = own(BLAIR, 'b2');
    for (const [index, text] of sent.entries()) {
      b2.device = index % 2 ? `${BLAIR}:b2` : null;
      await send(alex, chat, text);
    }
    expect(server.groups.size).toBe(11);

    let caughtUp = false;
    const stop = casey.engine.subscribe(() => { caughtUp ||= casey.engine.snapshot().conversations[0]?.catching_up; });
    await syncAll(casey);
    stop();
    expect(caughtUp).toBe(true);
    expect(casey.engine.snapshot().conversations[0].catching_up).toBe(false);
    expect(texts(casey, chat)).toEqual(['before', ...sent]);
  });

  it('local retention deletes old messages only, and none during the wait', async () => {
    const [alex, blair, casey] = [await person(ALEX, 'a1'), await person(BLAIR, 'b1'), await person(CASEY, 'c1')];
    const chat = await planning(alex, blair, casey);
    server.state.ageDays = 40;
    await send(alex, chat, 'from forty days ago');
    server.state.ageDays = 0;
    await send(alex, chat, 'from today');
    const conversation = server.conversations.get(chat)!;
    conversation.retention = { days: 30, from: new Date(Date.now() + 3_600_000).toISOString() };
    await syncAll(alex, blair);
    expect(blair.engine.snapshot().conversations[0]).toMatchObject({ retention_days: 30, retention_from: conversation.retention.from });
    for (const on of [alex, blair]) expect(texts(on, chat)).toEqual(['from forty days ago', 'from today']);

    conversation.retention = { days: 30, from: new Date(Date.now() - 60_000).toISOString() };
    await syncAll(alex, blair);
    for (const on of [alex, blair]) expect(texts(on, chat)).toEqual(['from today']);
    expect((on => on.engine.thread(chat)!.filter((item): item is ChatThreadMessage => item.kind === 'message'))(blair)).toHaveLength(1);
  });
});
