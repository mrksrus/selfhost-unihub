// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadMls, withMls, type MlsDevice, type MlsEntry } from '@/lib/chat/mls';

const built = path.resolve(__dirname, '../lib/chat/mls-module/chat_mls_bg.wasm');
const text = (value: string) => new TextEncoder().encode(value);
const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const group = text('group-1');

// The module is built only where its Rust tool chain is (CI and the image); CI must have it.
describe.skipIf(!existsSync(built) && !process.env.CI)('Chat\'s MLS module, built to WebAssembly', () => {
  beforeAll(() => loadMls(readFileSync(built)));

  /** Every entry a device handed out so far, as the page stores them. */
  function stored(device: MlsDevice, store = new Map<string, MlsEntry>()) {
    for (const entry of device.changes()) {
      if (entry.value) store.set(entry.key.join(), entry);
      else store.delete(entry.key.join());
    }
    return store;
  }

  it('two devices make a group, exchange messages, and go on after the module starts again', async () => {
    const [alex, blair] = await withMls(mls => [mls.Device.create(text('alex-1')), mls.Device.create(text('blair-1'))]);
    const welcome = alex.create_group(group, blair.key_package());
    expect(read(blair.join(welcome))).toBe('group-1');
    expect(read(blair.decrypt(group, alex.encrypt(group, text('hello'))))).toBe('hello');
    expect(read(alex.decrypt(group, blair.encrypt(group, text('hi alex'))))).toBe('hi alex');
    expect(() => alex.decrypt(group, text('not a message'))).toThrow();

    // A trap throws the module's memory away; the devices come back from their stored entries.
    const states = [stored(alex), stored(blair)];
    (await import('@/lib/chat/mls-module/chat_mls.js' as string)).__wbg_reset_state();
    const [alex2, blair2] = await withMls(mls => states.map(state => {
      const device = new mls.Device();
      for (const { key, value } of state.values()) device.put(key, value!);
      return device;
    }));
    expect(read(blair2.decrypt(group, alex2.encrypt(group, text('after the restart'))))).toBe('after the restart');
  });
});
