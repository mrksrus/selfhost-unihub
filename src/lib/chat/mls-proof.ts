// A development page (/mls-proof.html?dev) that proves Chat's MLS module in a
// real browser under the image's headers; the end-to-end tests drive it.
// Blobs cross between browsers through the test as base64 text. The device
// keeps its state in localStorage, the simplest store that survives a reload.
import { loadMls, withMls, type MlsDevice, type MlsModule } from './mls';

const STORE = 'unihub-mls-proof';
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
const unbase64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
const concat = (parts: Uint8Array[]) => {
  const all = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  parts.reduce((offset, part) => (all.set(part, offset), offset + part.length), 0);
  return all;
};

/** Applies a device's changed entries to a store of base64 keys and values. */
function keep(device: MlsDevice, store: Record<string, string>) {
  for (const { key, value } of device.changes()) {
    if (value) store[base64(key)] = base64(value);
    else delete store[base64(key)];
  }
  return store;
}

function restore(mls: MlsModule, store: Record<string, string>) {
  const device = new mls.Device();
  for (const [key, value] of Object.entries(store)) device.put(unbase64(key), unbase64(value));
  return device;
}

let device: MlsDevice | null = null;
const stored = (): Record<string, string> | null => JSON.parse(localStorage.getItem(STORE) ?? 'null');

async function reopen() {
  const store = stored();
  device = store && await withMls(mls => restore(mls, store));
  return device !== null;
}

/** One step on this page's device; its changes are stored before the result is returned. */
async function step<T>(call: (device: MlsDevice) => T): Promise<T> {
  if (!device) throw new Error('no device: enrol first');
  try {
    const result = await withMls(() => call(device!));
    localStorage.setItem(STORE, JSON.stringify(keep(device!, stored() ?? {})));
    return result;
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) await reopen();
    throw error;
  }
}

const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10;

const proof = {
  /** Whether a device was stored by an earlier visit (it is loaded then). */
  reopen,
  /** A new device for this browser; returns one key package. */
  async enrol(name: string) {
    device = await withMls(mls => mls.Device.create(encode(name)));
    localStorage.setItem(STORE, JSON.stringify(keep(device, {})));
    return base64(await step(d => d.key_package()));
  },
  createGroup: (groupId: string, keyPackages: string[]) =>
    step(d => base64(d.create_group(encode(groupId), concat(keyPackages.map(unbase64))))),
  join: (welcome: string) => step(d => decode(d.join(unbase64(welcome)))),
  encrypt: (groupId: string, text: string) => step(d => base64(d.encrypt(encode(groupId), encode(text)))),
  decrypt: (groupId: string, message: string) => step(d => decode(d.decrypt(encode(groupId), unbase64(message)))),
  /**
   * A group of `devices` devices inside this page: how long creating it and
   * joining it take, then messages both ways, and the joined device read once
   * more after it was loaded again from its stored entries.
   */
  async measure(devices: number) {
    return withMls(mls => {
      const [creator, ...members] = Array.from({ length: devices }, (_, i) => mls.Device.create(encode(`device-${i}`)));
      const packages = concat(members.map(member => member.key_package()));
      let start = performance.now();
      const welcome = creator.create_group(encode('measure'), packages);
      const createMs = ms(start);
      const joiner = members[members.length - 1];
      start = performance.now();
      joiner.join(welcome);
      const joinMs = ms(start);
      const store = keep(joiner, {});
      const read = [decode(joiner.decrypt(encode('measure'), creator.encrypt(encode('measure'), encode('hello'))))];
      read.push(decode(creator.decrypt(encode('measure'), joiner.encrypt(encode('measure'), encode('hi back')))));
      const reloaded = restore(mls, keep(joiner, store));
      read.push(decode(reloaded.decrypt(encode('measure'), creator.encrypt(encode('measure'), encode('after reload')))));
      for (const each of [creator, ...members, reloaded]) each.free();
      return { devices, createMs, joinMs, welcomeBytes: welcome.length, read };
    });
  },
};

if (new URLSearchParams(location.search).has('dev')) {
  Object.assign(window, { mlsProof: proof });
  const status = document.getElementById('status')!;
  loadMls().then(() => { status.textContent = 'MLS module ready'; }, error => { status.textContent = `MLS module failed: ${error}`; });
}
