// A test hook on the app's own page (/#chat-test): Chat's devices with their
// IndexedDB stores and the MLS module in a real browser, without a server. The
// end-to-end and emulator tests drive it (chat-device.e2e.ts and
// chat-device.test.mjs under tools/e2e) and carry the blobs between devices as
// the server will.
import { concat, fromBase64Url, toBase64Url } from './bytes';
import { ChatDevice } from './device';
import { MlsError } from './mls';
import { ChatStore } from './store';

const devices = new Map<string, ChatDevice>();
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const device = (name: string) => devices.get(name) ?? Promise.reject(new Error(`no device ${name}: enrol first`));
const store = (name: string) => ChatStore.open(`test-hook-${name}`);
// The module's glue: its init answers the running instance's exports.
const [glue] = Object.values(import.meta.glob<{ default(): Promise<{ __wbindgen_malloc(size: number, align: number): number }> }>('./mls-module/chat_mls.js'));

const chatTest = {
  /** A new device named `name`; returns one key package. */
  async enrol(name: string) {
    devices.set(name, await ChatDevice.create(await store(name), name));
    return toBase64Url(await (await device(name)).step(mls => mls.key_package(false)));
  },
  /** Loads a device from its store, as after a reload; false when it has none. */
  async reopen(name: string) {
    const opened = await ChatDevice.open(await store(name));
    if (opened) devices.set(name, opened);
    return opened !== null;
  },
  createGroup: async (name: string, groupId: string, keyPackages: string[]) =>
    toBase64Url(await (await device(name)).step(mls => mls.create_group(encode(groupId), concat(...keyPackages.map(fromBase64Url))))),
  join: async (name: string, welcome: string) => decode(await (await device(name)).step(mls => mls.join(fromBase64Url(welcome)))),
  encrypt: async (name: string, groupId: string, text: string) =>
    toBase64Url(await (await device(name)).step(mls => mls.encrypt(encode(groupId), encode(text)))),
  decrypt: async (name: string, groupId: string, message: string) =>
    decode(await (await device(name)).step(mls => mls.decrypt(encode(groupId), fromBase64Url(message)))),
  /**
   * Crashes the module for real, as a panic does: its allocator aborts (the
   * `unreachable` trap) on an alignment that is not a power of two. True when
   * the step reported the restart (MlsError `stopped`).
   */
  async trap(name: string) {
    const exports = await (await glue()).default();
    return (await device(name)).step(() => { exports.__wbindgen_malloc(8, 3); })
      .then(() => false, (error: unknown) => error instanceof MlsError && error.kind === 'stopped');
  },
};

Object.assign(window, { chatTest });
