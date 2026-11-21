// @vitest-environment node
import { ALEX, BLAIR, PASSPHRASES, context, message, open, pair, send, server, settled, tab, texts, until, chatDeliveryHooks } from './chat-delivery';
import { describe, expect, it } from 'vitest';
import { ChatStore, wipeChatStores } from '@/lib/chat/store';
import type { ChatThreadMessage } from '@/lib/chat/types';

// Chat's engine for two people (direct chats) against the in-memory delivery service.

chatDeliveryHooks();

describe('the chat engine', { timeout: 60_000 }, () => {
  it('Alex and Blair write on three devices; a device added later reads new messages and old ones after the passphrase', async () => {
    const { alex, blair, conversation } = await pair();
    const blair2 = open(BLAIR, 'b2');
    await settled(blair2);
    expect(blair2.engine.snapshot().readiness.state).toBe('waiting');
    await blair2.as(engine => engine.enterPassphrase(PASSPHRASES[BLAIR]));

    await send(alex, conversation, 'hello blair');
    for (const on of [blair, blair2]) await on.as(engine => engine.sync());
    expect(texts(blair, conversation)).toEqual(['hello blair']);
    expect(texts(blair2, conversation)).toEqual(['hello blair']);
    expect(message(blair, conversation, 'hello blair')).toMatchObject({ from_me: false, sender_name: 'Alex Example', delivery: null });

    await send(blair2, conversation, 'hi alex, from my second browser');
    for (const on of [alex, blair]) await on.as(engine => engine.sync());
    expect(texts(alex, conversation)).toEqual(['hello blair', 'hi alex, from my second browser']);
    expect(message(blair, conversation, 'hi alex, from my second browser')?.from_me).toBe(true);
    // Each device fetched it, so the other person's devices delivered it.
    await alex.as(engine => engine.sync());
    expect(message(alex, conversation, 'hello blair')?.delivery).toBe('delivered');
    expect(blair.engine.snapshot().conversations[0]).toMatchObject({ peer: { name: 'Alex Example' }, last_message: { text: 'hi alex, from my second browser', from_me: true } });

    // Blair's third browser, after both wrote: the new messages once it joined with the passphrase, the old ones from the archive.
    const blair3 = open(BLAIR, 'b3');
    await settled(blair3);
    // A copy put under another message's id is dropped on restore.
    const copies = [...server.archive.values()].filter(copy => copy.user === BLAIR);
    const [first, second] = [copies.find(copy => server.messages.find(item => item.id === copy.message)?.seq === 1)!, copies.find(copy => server.messages.find(item => item.id === copy.message)?.seq === 2)!];
    second.sealed = first.sealed;
    // The connection breaks while the history is read: the key is kept, the device joined, and the next sync reads the history.
    server.state.failArchive = true;
    await expect(blair3.as(engine => engine.enterPassphrase(PASSPHRASES[BLAIR]))).rejects.toThrow();
    expect(blair3.engine.snapshot()).toMatchObject({ readiness: { state: 'ready' }, holds_history_key: true });
    await send(alex, conversation, 'blair has a new browser');
    expect(alex.engine.thread(conversation)!.some(item => item.kind === 'device-added' && item.name === 'Blair Example')).toBe(true);
    await blair3.as(engine => engine.sync());
    expect(texts(blair3, conversation)).toEqual(['hello blair', '(unreadable)', 'blair has a new browser']);
    expect(blair3.engine.snapshot()).toMatchObject({ readiness: { state: 'ready' }, holds_history_key: true, restore: null });
  });

  it('a removed device reads nothing sent after; an edit and a delete reach every device; deleting is refused under the policy', async () => {
    const { alex, blair, conversation } = await pair();
    const blair2 = open(BLAIR, 'b2');
    await settled(blair2);
    await blair2.as(engine => engine.enterPassphrase(PASSPHRASES[BLAIR]));
    await send(alex, conversation, 'to both browsers');
    await send(alex, conversation, 'to be deleted');
    for (const on of [blair, blair2]) await on.as(engine => engine.sync());
    expect(texts(blair2, conversation)).toEqual(['to both browsers', 'to be deleted']);

    const original = message(alex, conversation, 'to both browsers')!.id;
    alex.as(engine => engine.edit(original, 'to both browsers, edited'));
    await until(alex, () => message(alex, conversation, 'to both browsers, edited')?.edit_state === null);
    for (const on of [blair, blair2]) await on.as(engine => engine.sync());
    for (const on of [blair, blair2]) expect(message(on, conversation, 'to both browsers, edited')).toMatchObject({ id: original, edited: true });

    server.state.forbidDelete = true;
    const doomed = message(alex, conversation, 'to be deleted')!.id;
    await expect(alex.as(engine => engine.delete(doomed))).rejects.toMatchObject({ code: 'POLICY_FORBIDS' });
    server.state.forbidDelete = false;
    await alex.as(engine => engine.delete(doomed));
    await blair.as(engine => engine.sync());
    expect(texts(alex, conversation)).toEqual(['to both browsers, edited', '(deleted)']);
    expect(texts(blair, conversation)).toEqual(['to both browsers, edited', '(deleted)']);

    // Blair removes the second browser (Settings › Devices); it still holds its keys and, here, still reaches the server.
    [...server.devices.values()].find(device => device.device === `${BLAIR}:b2`)!.device = null;
    await send(alex, conversation, 'after the removal');
    await blair.as(engine => engine.sync());
    expect(texts(blair, conversation).at(-1)).toBe('after the removal');
    // It has no chat device in Chat any more, so the server refuses it what it fetches.
    await expect(blair2.as(engine => engine.sync())).rejects.toMatchObject({ code: 'CHAT_DEVICE_WAITING' });
    expect(texts(blair2, conversation)).not.toContain('after the removal');
  });

  it('two devices that make a group at once converge, and messages written offline arrive in order', async () => {
    const { alex, blair, conversation } = await pair();
    let open!: () => void;
    server.state.groupGate = { waiting: 0, size: 2, open: () => open(), opened: new Promise(resolve => { open = resolve; }) };
    alex.as(engine => engine.send(conversation, 'alex first'));
    blair.as(engine => engine.send(conversation, 'blair first'));
    await Promise.all([until(alex, () => message(alex, conversation, 'alex first')?.delivery === 'sent'),
      until(blair, () => message(blair, conversation, 'blair first')?.delivery === 'sent')]);
    server.state.groupGate = null;
    expect(server.groups.size).toBe(1);
    for (const on of [alex, blair]) await on.as(engine => engine.sync());
    expect(texts(alex, conversation).sort()).toEqual(['alex first', 'blair first']);
    expect(texts(blair, conversation).sort()).toEqual(['alex first', 'blair first']);

    const refused = new Promise<void>(resolve => { server.state.refusedOffline = resolve; });
    blair.browser.offline = true;
    for (const text of ['one', 'two', 'three']) blair.as(engine => engine.send(conversation, text));
    await refused;
    await until(blair, () => texts(blair, conversation).length === 5);
    expect(blair.engine.thread(conversation)!.slice(-3).map(item => (item as ChatThreadMessage).delivery)).toEqual(['sending', 'sending', 'sending']);
    blair.browser.offline = false;
    await blair.as(engine => engine.sync());
    await alex.as(engine => engine.sync());
    expect(texts(alex, conversation).slice(-3)).toEqual(['one', 'two', 'three']);
    expect(server.messages.slice(-3).map(item => item.seq)).toEqual([3, 4, 5]);
  });

  it('a group whose answer was lost is still read, and a device enrolled again writes first', async () => {
    const { alex, blair, conversation } = await pair();
    const lost = new Promise<void>(resolve => { server.state.refusedOffline = resolve; });
    server.state.loseGroupAnswer = true;
    alex.as(engine => engine.send(conversation, 'alex first'));
    await lost;
    await blair.as(engine => engine.sync());
    await send(blair, conversation, 'blair answers');
    alex.browser.offline = false;
    await alex.as(engine => engine.sync());
    await until(alex, () => message(alex, conversation, 'alex first')?.delivery === 'sent');
    await blair.as(engine => engine.sync());
    expect(texts(alex, conversation).sort()).toEqual(['alex first', 'blair answers']);
    expect(texts(blair, conversation).sort()).toEqual(['alex first', 'blair answers']);
    expect(server.groups.size).toBe(1);

    // Alex's device is removed (Settings › Devices, a restore); the same browser opens Chat again and writes first.
    alex.engine.stop();
    [...server.devices.values()].find(device => device.device === `${ALEX}:a1`)!.device = null;
    const again = tab(alex.browser);
    await settled(again);
    await send(again, conversation, 'from the device enrolled again');
    await blair.as(engine => engine.sync());
    expect(texts(blair, conversation).at(-1)).toBe('from the device enrolled again');
    expect(texts(again, conversation)).toEqual(expect.arrayContaining(['alex first', 'blair answers', 'from the device enrolled again']));
  });

  it('two tabs share one device without corrupting it, and sign-out leaves no store and no key', async () => {
    const { alex, blair, conversation } = await pair();
    const second = tab(alex.browser);
    await settled(second);
    // The second tab waits for the lock: it reads the store and sends through the first.
    second.as(engine => engine.send(conversation, 'from the second tab'));
    await until(second, () => message(second, conversation, 'from the second tab')?.delivery === 'sent');
    expect(message(alex, conversation, 'from the second tab')?.delivery).toBe('sent');

    // The first tab closes: the second takes the lock and goes on with the same device.
    alex.engine.stop();
    await send(second, conversation, 'the second tab took over');
    await blair.as(engine => engine.sync());
    expect(texts(blair, conversation)).toEqual(['from the second tab', 'the second tab took over']);
    expect([...server.devices.values()].filter(device => device.user_id === ALEX)).toHaveLength(1);

    // Another person's store in the same browser goes when Alex signs in; Alex's own at sign-out.
    await context.run(alex.browser, async () => (await ChatStore.open('casey')).close());
    second.engine.stop();
    await context.run(alex.browser, () => wipeChatStores(ALEX));
    expect((await alex.browser.idb.databases()).map(item => item.name)).toEqual([`unihub-chat:${ALEX}`]);
    await context.run(alex.browser, () => wipeChatStores());
    expect(await alex.browser.idb.databases()).toEqual([]);
    // A browser that cannot list its databases still deletes the store of the person who signs out.
    await context.run(alex.browser, async () => (await ChatStore.open(ALEX)).close());
    const listing = alex.browser.idb.databases;
    Object.defineProperty(alex.browser.idb, 'databases', { value: undefined, configurable: true });
    await context.run(alex.browser, () => wipeChatStores(undefined, [ALEX]));
    Object.defineProperty(alex.browser.idb, 'databases', { value: listing, configurable: true });
    expect(await alex.browser.idb.databases()).toEqual([]);
  });
});
