// A test hook on the app's own page (/#chat-test): Chat's devices with their
// IndexedDB stores and the MLS module in a real browser, without a server, and
// the passphrase of the page's own Chat. The end-to-end and emulator tests
// under tools/e2e drive it; for bare devices they carry the blobs between them
// as the server does.
import { concat, fromBase64Url, toBase64Url } from './bytes';
import { ChatDevice } from './device';
import { MlsError, withMls, type MlsDevice } from './mls';
import { ChatStore } from './store';

const devices = new Map<string, ChatDevice>();
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const device = (name: string) => devices.get(name) ?? Promise.reject(new Error(`no device ${name}: enrol first`));
// Not a person's store: signing in wipes those of everyone but the person signed in.
const store = (name: string) => ChatStore.open(name, `unihub-chat-test:${name}`);

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
   * Times making a group of `count` devices and joining it, each stored as the
   * engine stores it; the other devices only give their key packages.
   */
  async measureGroup(count: number) {
    const [maker, joiner] = await Promise.all(['measure-maker', 'measure-joiner'].map(async name => ChatDevice.create(await store(name), name)));
    const packages = [await joiner.step(mls => mls.key_package(false)), ...await withMls(mls => Array.from({ length: count - 2 }, (_, index) => {
      const other = mls.Device.create(encode(`measure-${index}`));
      try { return other.key_package(false); } finally { other.free(); }
    }))];
    let started = performance.now();
    const welcome = await maker.step(mls => mls.create_group(encode('measure-group'), concat(...packages)));
    const create_ms = Math.round(performance.now() - started);
    started = performance.now();
    const joined = decode(await joiner.step(mls => mls.join(welcome)));
    const join_ms = Math.round(performance.now() - started);
    maker.free();
    joiner.free();
    return JSON.stringify({ joined, create_ms, join_ms, welcome_bytes: welcome.length });
  },
  /**
   * Crashes the module for real, with a panic: a new MLS device seeds its
   * randomness from the page, and without it the module panics, which traps.
   * Answers the error kind the step reported ('stopped' when the module
   * started again).
   */
  trap: async (name: string) => (await device(name)).step(mls => {
    const random = crypto.getRandomValues;
    crypto.getRandomValues = () => { throw new Error('no randomness'); };
    try {
      new (mls.constructor as new () => MlsDevice)();
    } finally {
      crypto.getRandomValues = random;
    }
  }).then(() => 'no trap', (error: unknown) => error instanceof MlsError ? error.kind : String(error)),
  /**
   * Chooses the signed-in person's chat passphrase in the page's own engine,
   * or enters it where Chat asks for it: the passphrase screens' stand-in.
   * Answers the state Chat was in.
   */
  async passphrase(passphrase: string) {
    const { user } = await (await fetch('/api/auth/me')).json() as { user: { id: string; full_name: string | null; email: string } };
    const { acquireChatEngine } = await import('./engine');
    const { engine, release } = acquireChatEngine({ id: user.id, name: user.full_name || user.email });
    try {
      const state = await new Promise<string>(resolve => {
        const check = () => { const { state } = engine.snapshot().readiness; if (state !== 'starting') { stop(); resolve(state); } };
        const stop = engine.subscribe(check);
        check();
      });
      if (state === 'choose-passphrase') await engine.choosePassphrase(passphrase);
      if (state === 'enter-passphrase') await engine.enterPassphrase(passphrase);
      return state;
    } finally {
      release();
    }
  },
};

Object.assign(window, { chatTest });
