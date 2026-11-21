// @vitest-environment node
import { context, message, pair, server, settled, tab, until, chatDeliveryHooks, type Tab } from './chat-delivery';
import { describe, expect, it, vi } from 'vitest';
import { fromBase64Url } from '@/lib/chat/bytes';
import { FileDecryptError, decryptFile, encryptFile, newFileKey } from '@/lib/chat/file-crypto';
import { parseFiles } from '@/lib/chat/files';
import { ChatStore } from '@/lib/chat/store';
import type { ChatThreadMessage } from '@/lib/chat/types';

// Chat files: the record encryption, and the outbox's "upload, then post" against the in-memory delivery service.

chatDeliveryHooks();

const stream = (bytes: Uint8Array | Blob) => new Blob([bytes as BlobPart]).stream();
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const RECORD = 65536;
const filler = (length: number) => Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff);

// A canvas in Node: the preview of a 1600×1200 picture is drawn at 320×240.
vi.stubGlobal('createImageBitmap', async () => ({ width: 1600, height: 1200, close() {} }));
vi.stubGlobal('OffscreenCanvas', class {
  constructor(public width: number, public height: number) {}
  getContext() { return { fillRect() {}, drawImage() {} }; }
  async convertToBlob() { return new Blob([`preview ${this.width}x${this.height}`], { type: 'image/jpeg' }); }
});

describe('a chat file\'s encryption', () => {
  it('opens both example vectors of RFC 8188', async () => {
    // Section 3.1: one record of 4096; section 3.2: records of 25 with a key id and padding.
    const one = await decryptFile(stream(fromBase64Url('I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg')), fromBase64Url('yqdlZ-tYemfogSmv7Ws5PQ'), 'text/plain');
    const two = await decryptFile(stream(fromBase64Url('uNCkWiNYzKTnBN9ji3-qWAAAABkCYTHOG8chz_gnvgOqdGYovxyjuqRyJFjEDyoF1Fvkj6hQPdPHI51OEUKEpgz3SsLWIqS_uA')),
      fromBase64Url('BO3ZVPxUlnLORbVGMpbT1Q'), 'text/plain');
    expect([await one.text(), await two.text()]).toEqual(['I am the walrus', 'I am the walrus']);
  });

  it('a file of several records comes back whole; one cut, with a record removed or swapped, or under another key is refused', async () => {
    const plain = filler(3 * RECORD + 100);
    const key = newFileKey();
    const progress: number[] = [];
    const sealed = await bytesOf(await encryptFile(new Blob([plain]), key, done => progress.push(done)));
    expect(progress.at(-1)).toBe(plain.length);
    const opened = await decryptFile(stream(sealed), key, 'application/pdf');
    expect(opened.type).toBe('application/pdf');
    expect(await bytesOf(opened)).toEqual(plain);
    // An empty file is one record.
    expect((await decryptFile(stream(await encryptFile(new Blob([]), key)), key, '')).size).toBe(0);

    const header = sealed.slice(0, 21);
    const records = [0, 1, 2, 3].map(index => sealed.slice(21 + index * RECORD, 21 + (index + 1) * RECORD));
    const join = (...parts: Uint8Array[]) => new Blob([header, ...parts as BlobPart[]]);
    for (const changed of [
      join(records[0], records[1], records[2]), // the last record cut away, at a record's border
      sealed.slice(0, sealed.length - 10), // cut inside the last record
      join(records[0], records[2], records[3]), // a record removed
      join(records[1], records[0], records[2], records[3]), // two records swapped
    ]) await expect(decryptFile(stream(changed), key, '')).rejects.toBeInstanceOf(FileDecryptError);
    await expect(decryptFile(stream(sealed), newFileKey(), '')).rejects.toBeInstanceOf(FileDecryptError);
  });
});

const picture = () => new Blob([filler(200_000)], { type: 'image/png' });
const pdf = new Blob(['%PDF-1.7 the minutes of Monday'], { type: 'application/pdf' });
const withFiles = (on: Tab, id: string) => (on.engine.thread(id) ?? []).find((item): item is ChatThreadMessage => item.kind === 'message' && item.files.length > 0);
const outbox = (on: Tab) => context.run(on.browser, async () => {
  const store = await ChatStore.open(on.browser.userId);
  try { return await store.all('outbox'); } finally { store.close(); }
});

describe('the file list of a received message', () => {
  it('leaves out a file whose id is not an id, and a preview that names the file itself', () => {
    const key = 'AAAAAAAAAAAAAAAAAAAAAA';
    const file = { id: '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', key, name: 'a.png', type: 'image/png', size: 10 };
    expect(parseFiles([{ ...file, id: '../conversations' }])).toEqual([]);
    expect(parseFiles([{ ...file, preview: { id: file.id, key, width: 10, height: 10 } }])).toEqual([file]);
    expect(parseFiles([{ ...file, preview: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', key, width: 10, height: 10 } }])[0].preview).toBeTruthy();
  });
});

describe('sending files', { timeout: 60_000 }, () => {
  it('a message with a picture and a PDF posts only after both uploads, survives a reload in between, and Blair opens both', async () => {
    const { alex, blair, conversation } = await pair();
    const photo = picture();
    // Offline after the picture and its preview were uploaded, before the PDF.
    server.state.onUpload = () => { if (server.state.uploads === 2) alex.browser.offline = true; };
    const refused = new Promise<void>(resolve => { server.state.refusedOffline = resolve; });
    alex.as(engine => engine.send(conversation, 'The minutes and the whiteboard', null, [], [{ blob: photo, name: 'whiteboard.png' }, { blob: pdf, name: 'Minutes.pdf' }]));
    await refused;
    await until(alex, () => withFiles(alex, conversation)?.files[1].state === 'waiting');
    expect(withFiles(alex, conversation)).toMatchObject({ delivery: 'sending', files: [
      { name: 'whiteboard.png', type: 'image/png', picture: { width: 1600, height: 1200 }, state: 'sent' }, { name: 'Minutes.pdf', state: 'waiting' }] });
    expect(server.messages).toHaveLength(0);

    // A reload: the outbox keeps the message, its files and what was uploaded.
    alex.engine.stop();
    const again = tab(alex.browser);
    await settled(again);
    expect(withFiles(again, conversation)?.files.map(file => file.state)).toEqual(['sent', 'waiting']);
    alex.browser.offline = false;
    await again.as(engine => engine.sync());
    await until(again, () => withFiles(again, conversation)?.delivery === 'sent');
    expect(server.state.uploads).toBe(3);
    const sent = withFiles(again, conversation)!;
    expect(server.posts.get(sent.id)?.attachments).toHaveLength(3);
    expect([...server.attachments.values()].every(file => file.message === sent.id)).toBe(true);
    expect(await outbox(again)).toEqual([]);

    await blair.as(engine => engine.sync());
    const received = message(blair, conversation, 'The minutes and the whiteboard')!;
    expect(received.files).toMatchObject([{ name: 'whiteboard.png', size: photo.size, picture: { width: 1600, height: 1200 }, state: 'sent', voice_seconds: null },
      { name: 'Minutes.pdf', type: 'application/pdf', size: pdf.size, picture: null, state: 'sent' }]);
    const parts: number[] = [];
    const opened = await blair.as(engine => engine.openFile(received.id, received.files[1].id, { onProgress: part => parts.push(part) }));
    expect([await opened.text(), opened.type, parts.at(-1)]).toEqual([await pdf.text(), 'application/pdf', 1]);
    expect(await bytesOf(await blair.as(engine => engine.openFile(received.id, received.files[0].id)))).toEqual(await bytesOf(photo));
    // The preview is fetched once, then read from the device.
    const before = server.state.downloads;
    for (let i = 0; i < 2; i++) expect(await (await blair.as(engine => engine.picturePreview(received.id, received.files[0].id)))!.text()).toBe('preview 320x240');
    expect(server.state.downloads).toBe(before + 1);
    expect(await blair.as(engine => engine.picturePreview(received.id, received.files[1].id))).toBeNull();
    expect(blair.as(engine => engine.search('minutes.p')).map(hit => hit.line)).toEqual(['Minutes.pdf']);

    // Deleted for both: neither device keeps the picture's preview, nor the files' names and keys.
    const kept = (on: Tab) => context.run(on.browser, async () => {
      const store = await ChatStore.open(on.browser.userId);
      try { return { previews: (await store.all('previews')).length, files: (await store.all<{ files?: unknown }>('messages')).filter(record => record.files).length }; } finally { store.close(); }
    });
    expect([await kept(again), await kept(blair)]).toEqual([{ previews: 1, files: 1 }, { previews: 1, files: 1 }]);
    await again.as(engine => engine.delete(sent.id));
    await blair.as(engine => engine.sync());
    expect([await kept(again), await kept(blair)]).toEqual([{ previews: 0, files: 0 }, { previews: 0, files: 0 }]);
  });

  it('a file above the limit fails with the limit in words and is sent with its message on retry; uploads older than the server keeps are made again', async () => {
    const { alex, blair, conversation } = await pair();
    server.state.fileLimitMb = 1;
    const big = new Blob([new Uint8Array(1_100_000)], { type: 'application/zip' });
    alex.as(engine => engine.send(conversation, '', null, [], [{ blob: big, name: 'photos.zip' }, { blob: new Blob(['voice'], { type: 'audio/webm' }), name: 'Voice message.webm', voice_seconds: 12 }]));
    await until(alex, () => withFiles(alex, conversation)?.delivery === 'failed');
    expect(withFiles(alex, conversation)!.files).toMatchObject([{ state: 'failed', error: 'Files in a chat can be at most 1 MB.' }, { state: 'failed', voice_seconds: 12 }]);
    expect(server.messages).toHaveLength(0);

    server.state.fileLimitMb = 50;
    const failed = withFiles(alex, conversation)!;
    alex.as(engine => engine.retry(failed.id));
    await until(alex, () => withFiles(alex, conversation)?.delivery === 'sent');
    await blair.as(engine => engine.sync());
    expect(blair.engine.thread(conversation)!.map(item => (item as ChatThreadMessage).files.map(file => file.name))).toEqual([['photos.zip', 'Voice message.webm']]);

    // Uploaded, then offline for longer than the server keeps an upload no message names.
    server.state.onUpload = () => { alex.browser.offline = true; };
    const refused = new Promise<void>(resolve => { server.state.refusedOffline = resolve; });
    alex.as(engine => engine.send(conversation, 'from the train', null, [], [{ blob: pdf, name: 'Agenda.pdf' }]));
    await refused;
    const first = [...server.attachments].find(([, file]) => !file.message)![0];
    server.sweepUnsent();
    server.state.onUpload = () => {};
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + 13 * 3_600_000);
    try {
      alex.browser.offline = false;
      await alex.as(engine => engine.sync());
      await until(alex, () => message(alex, conversation, 'from the train')?.delivery === 'sent');
    } finally {
      vi.restoreAllMocks();
    }
    const [id] = server.posts.get(message(alex, conversation, 'from the train')!.id)!.attachments!;
    expect(id).not.toBe(first);
    await blair.as(engine => engine.sync());
    const agenda = message(blair, conversation, 'from the train')!;
    expect(await (await blair.as(engine => engine.openFile(agenda.id, agenda.files[0].id))).text()).toBe(await pdf.text());
  });

  it('a cancelled upload leaves nothing in the outbox and posts nothing', async () => {
    const { alex, blair, conversation } = await pair();
    server.state.holdUploads = true;
    const started = new Promise<void>(resolve => { server.state.onHold = resolve; });
    alex.as(engine => engine.send(conversation, 'never mind', null, [], [{ blob: pdf, name: 'Draft.pdf' }]));
    await started;
    await until(alex, () => withFiles(alex, conversation)?.files[0].state === 'uploading');
    await alex.as(engine => engine.delete(withFiles(alex, conversation)!.id));
    expect(alex.engine.thread(conversation)).toEqual([]);
    expect(await outbox(alex)).toEqual([]);
    // The outbox goes on with what follows.
    server.state.holdUploads = false;
    alex.as(engine => engine.send(conversation, 'only this'));
    await until(alex, () => message(alex, conversation, 'only this')?.delivery === 'sent');
    await blair.as(engine => engine.sync());
    expect(blair.engine.thread(conversation)!.map(item => (item as ChatThreadMessage).text)).toEqual(['only this']);
    expect([...server.attachments.values()].some(file => file.message)).toBe(false);
    expect(server.posts.size).toBe(1);
  });
});
