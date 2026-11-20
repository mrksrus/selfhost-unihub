// This browser's chat device: its MLS identity in the module, loaded from and
// stored to the person's ChatStore, and its enrolment with the server (key
// packages, a last resort, and in a browser the preview key).
import { api } from '@/lib/api';
import { hasCode, unwrap } from '@/lib/api-error';
import { androidApp } from '@/lib/platform';
import type { ChatDeviceEnrolRequest, ChatDeviceResponse, ChatKeyPackagesRequest } from '../../../api/src/contracts/chat';
import { toBase64Url } from './bytes';
import { MlsError, withMls, type MlsDevice } from './mls';
import { createSealKey } from './seal';
import type { ChatDeviceRecord, ChatStore } from './store';

/** Unclaimed key packages the server keeps for a device. */
export const KEY_PACKAGES = 100;

async function load(store: ChatStore) {
  const entries = await store.state();
  return withMls(mls => {
    const device = new mls.Device();
    for (const { key, value } of entries) device.put(key, value!);
    return device;
  });
}

const keyPackages = (mls: MlsDevice, count: number) => Array.from({ length: count }, () => mls.key_package(false));

export class ChatDevice {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly store: ChatStore, private mls: MlsDevice, private record: ChatDeviceRecord) {}

  /** The device stored in `store`, or null before one was made there. */
  static async open(store: ChatStore): Promise<ChatDevice | null> {
    const record = await store.get<ChatDeviceRecord>('keys', 'device');
    return record ? new ChatDevice(store, await load(store), record) : null;
  }

  /** A new MLS identity in `store`, replacing the state of any earlier one; the server does not know it yet. */
  static async create(store: ChatStore, name: string): Promise<ChatDevice> {
    const record: ChatDeviceRecord = { name, chat_device_id: null };
    const device = new ChatDevice(store, await withMls(mls => mls.Device.create(new TextEncoder().encode(name))), record);
    await device.step(() => undefined, transaction => {
      transaction.objectStore('state').clear();
      transaction.objectStore('keys').put(record, 'device');
    });
    return device;
  }

  get id() { return this.record.chat_device_id; }
  get name() { return this.record.name; }

  /**
   * Runs one call on the module and stores what it changed together with
   * `writes`, in one transaction. Steps run one at a time. When the call, the
   * module or the write fails, the device is loaded again from the store, so
   * memory never holds a state that was not stored, and the error is thrown.
   */
  step<T>(call: (mls: MlsDevice) => T, writes?: (transaction: IDBTransaction, result: T) => void): Promise<T> {
    const run = async () => {
      try {
        const [result, changes] = await withMls(() => [call(this.mls), this.mls.changes()] as const);
        await this.store.write(changes, transaction => writes?.(transaction, result));
        return result;
      } catch (error) {
        // After a trap the module started again, and the old device's memory is gone with it.
        if (!(error instanceof MlsError && error.kind === 'stopped')) try { this.mls.free(); } catch { /* freed before */ }
        this.mls = await load(this.store);
        throw error;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Stores the id the server gave this device at its enrolment. */
  async enrolled(chat_device_id: string) {
    const record = { ...this.record, chat_device_id };
    await this.step(() => undefined, transaction => { transaction.objectStore('keys').put(record, 'device'); });
    this.record = record;
  }

  /** Brings the server's unclaimed key packages back to KEY_PACKAGES. */
  async topUp(unclaimed: number) {
    if (unclaimed >= KEY_PACKAGES) return;
    // Stored before the server has them: a package it hands out always has its private part here.
    const packages = await this.step(mls => keyPackages(mls, KEY_PACKAGES - unclaimed));
    unwrap(await api.post<ChatDeviceResponse>('/chat/devices/current/key-packages', { key_packages: packages.map(toBase64Url) } satisfies ChatKeyPackagesRequest));
  }
}

/**
 * Makes and enrols a new chat device for this browser: a new MLS identity,
 * KEY_PACKAGES key packages and a last resort, and outside the Android app a
 * preview key (the app's previews use its push keys). Nothing is asked.
 */
export async function enrol(store: ChatStore, userId: string): Promise<ChatDevice> {
  const device = await ChatDevice.create(store, `${userId}/${crypto.randomUUID()}`);
  const preview = androidApp() ? null : await createSealKey(false);
  const { packages, lastResort } = await device.step(mls => ({ packages: keyPackages(mls, KEY_PACKAGES), lastResort: mls.key_package(true) }),
    transaction => { if (preview) transaction.objectStore('keys').put(preview, 'preview'); else transaction.objectStore('keys').delete('preview'); });
  const request: ChatDeviceEnrolRequest = {
    preview: preview && { p256dh: toBase64Url(preview.publicKey), auth: toBase64Url(preview.auth) },
    key_packages: packages.map(toBase64Url),
    last_resort: toBase64Url(lastResort),
  };
  await device.enrolled(unwrap(await api.post<ChatDeviceResponse>('/chat/devices', request))!.chat_device_id);
  return device;
}

/**
 * This browser's chat device at the start of the page: the stored one, topped
 * up, while the server still knows it; otherwise a new one is enrolled (never
 * enrolled, a step that did not finish, signed out or removed since).
 * Messages already in the store stay.
 */
export async function startDevice(store: ChatStore, userId: string): Promise<ChatDevice> {
  const stored = await ChatDevice.open(store);
  if (stored?.id) {
    try {
      const current = unwrap(await api.get<ChatDeviceResponse>('/chat/devices/current'))!;
      if (current.chat_device_id === stored.id) {
        await stored.topUp(current.key_packages);
        return stored;
      }
    } catch (error) {
      if (!hasCode(error, 'CHAT_DEVICE_NOT_ENROLLED')) throw error;
    }
  }
  return enrol(store, userId);
}
