// Chat's MLS module (crypto/chat-mls, built into ./mls-module/ by npm run
// build:crypto). This is the only file that imports it.

/** One state entry a device changed; no value means it was deleted. */
export interface MlsEntry {
  readonly key: Uint8Array;
  readonly value?: Uint8Array;
}

/** A device's MLS state inside the module (crypto/chat-mls/src/lib.rs). */
export interface MlsDevice {
  put(key: Uint8Array, value: Uint8Array): void;
  changes(): MlsEntry[];
  key_package(lastResort: boolean): Uint8Array;
  create_group(groupId: Uint8Array, keyPackages: Uint8Array): Uint8Array;
  join(welcome: Uint8Array): Uint8Array;
  encrypt(groupId: Uint8Array, text: Uint8Array): Uint8Array;
  decrypt(groupId: Uint8Array, message: Uint8Array): Uint8Array;
  /** The credential names of the group's members, this device's included. */
  members(groupId: Uint8Array): string[];
  delete_group(groupId: Uint8Array): void;
  free(): void;
}

export interface MlsModule {
  Device: { new (): MlsDevice; create(name: Uint8Array): MlsDevice };
}

interface Generated extends MlsModule {
  default(input: { module_or_path: string | BufferSource }): Promise<unknown>;
  __wbg_reset_state(): void;
}

// Globs, so that typechecks and tests run where the module was not built (no Rust); the image always builds it.
const glue = import.meta.glob<Generated>('./mls-module/chat_mls.js');
const binary = import.meta.glob<string>('./mls-module/chat_mls_bg.wasm', { query: '?url', import: 'default' });

export class MlsUnavailableError extends Error {
  constructor() {
    super('Chat needs WebAssembly, which this browser has switched off.');
  }
}

/**
 * Why a call failed: `refused` for a message, Welcome or key package from
 * elsewhere that is malformed or fails its checks; `unknown-group`;
 * `no-identity` for a device without its keys; `stopped` when the module
 * trapped and started again; `failed` for anything else.
 */
export type MlsErrorKind = 'refused' | 'unknown-group' | 'no-identity' | 'stopped' | 'failed';

export class MlsError extends Error {
  constructor(readonly kind: MlsErrorKind, message: string) {
    super(message);
    this.name = 'MlsError';
  }
}

const KINDS: readonly string[] = ['refused', 'unknown-group', 'no-identity', 'failed'];

let loading: Promise<Generated> | null = null;

/** Fetches and starts the module once. Tests pass its bytes; the page fetches it. */
export function loadMls(bytes?: BufferSource): Promise<MlsModule> {
  loading ??= (async () => {
    if (typeof WebAssembly !== 'object') throw new MlsUnavailableError();
    const [loadGlue] = Object.values(glue);
    const [loadUrl] = Object.values(binary);
    if (!loadGlue || !loadUrl) throw new Error('Chat\'s MLS module was not built (npm run build:crypto).');
    const mls = await loadGlue();
    await mls.default({ module_or_path: bytes ?? await loadUrl() });
    return mls;
  })();
  // A failed fetch may work next time; a browser without WebAssembly stays without it.
  loading.catch(error => { if (!(error instanceof MlsUnavailableError)) loading = null; });
  return loading;
}

/**
 * Runs one call on the module. A trap (a panic inside it, for example on a
 * bad message) leaves its memory unusable: the module starts again empty and
 * MlsError `stopped` is thrown, so the caller loads its devices again from
 * what it stored and loses only that one call. The module's own errors
 * ("<kind>: <detail>" strings) are thrown as MlsError too.
 */
export async function withMls<T>(call: (mls: MlsModule) => T): Promise<T> {
  const mls = await loadMls() as Generated;
  try {
    return call(mls);
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      mls.__wbg_reset_state();
      throw new MlsError('stopped', error.message);
    }
    if (typeof error !== 'string') throw error;
    const [, kind, detail] = /^([a-z-]+): ([\s\S]*)$/.exec(error) ?? [];
    throw KINDS.includes(kind) ? new MlsError(kind as MlsErrorKind, detail) : new MlsError('failed', error);
  }
}
