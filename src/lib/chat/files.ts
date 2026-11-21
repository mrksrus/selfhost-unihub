// Chat files on the device: the list inside a message, picture previews,
// upload and download. The server stores ciphertext only; names, types, keys
// and previews' sizes travel inside the encrypted message.
import { chatApi } from '@/lib/chat-api';
import { fromBase64Url, toBase64Url } from './bytes';
import { decryptFile, encryptFile, newFileKey } from './file-crypto';
import type { ChatFileToSend } from './types';

export const MAX_FILES = 10;
/** The server ties at most this many uploads to a post, previews included: a picture beyond them goes without one. */
const MAX_IDS = 10;
const PREVIEW_PIXELS = 320;
/** The server deletes an upload no message names after a day; one kept longer than this is uploaded again under a new id. */
const UPLOAD_KEPT_MS = 12 * 3_600_000;
const MAX_SIZE = 101 * 1024 * 1024;

/** A file as a message carries it. */
export interface ChatFileRef {
  id: string;
  /** The file's 16-byte key, base64url. */
  key: string;
  name: string;
  type: string;
  size: number;
  /** A picture's preview, a second upload; width and height are the picture's. */
  preview?: { id: string; key: string; width: number; height: number };
  voice_seconds?: number;
}

/** A file in the outbox: the original, its preview, and when it was uploaded (null: not yet). */
export interface OutgoingFile extends ChatFileRef { blob: Blob; preview_blob?: Blob; uploaded_at: number | null }

const str = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
const count = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const keyed = (value: Record<string, unknown>) => str(value.id, 64) && typeof value.key === 'string' && fromBase64Url(value.key).length === 16;

/** The file list of a received message or archive copy; anything malformed is left out. */
export function parseFiles(value: unknown): ChatFileRef[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_FILES).flatMap((item: Record<string, unknown>) => {
    try {
      if (!item || !keyed(item) || !str(item.name, 255) || !str(item.type, 255) || !count(item.size, MAX_SIZE)) return [];
      const preview = item.preview as Record<string, unknown> | undefined;
      const picture = preview && keyed(preview) && count(preview.width, 100_000) && count(preview.height, 100_000);
      return [{ id: item.id, key: item.key, name: item.name, type: item.type, size: item.size,
        ...picture ? { preview: { id: preview.id, key: preview.key, width: preview.width, height: preview.height } } : {},
        ...count(item.voice_seconds, 600) ? { voice_seconds: item.voice_seconds } : {} } as ChatFileRef];
    } catch {
      return [];
    }
  });
}

/** What a message carries of an outgoing file. */
export const fileRef = ({ blob: _blob, preview_blob: _preview, uploaded_at: _at, ...ref }: OutgoingFile): ChatFileRef => ref;

/** A picture the browser can draw (GIF: its first frame), at most 320 px on its longer side, as JPEG; null for anything else. */
async function makePreview(blob: Blob) {
  if (!/^image\/(jpeg|png|webp|gif)$/.test(blob.type)) return null;
  const image = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, PREVIEW_PIXELS / Math.max(image.width, image.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    const context = canvas.getContext('2d')!;
    // JPEG has no transparency.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }), width: image.width, height: image.height };
  } finally {
    image.close();
  }
}

const keyText = () => toBase64Url(newFileKey());

/** The outbox's files for a message: ids, keys and previews, which fit the server's count of uploads. */
export async function outgoingFiles(files: ChatFileToSend[]): Promise<OutgoingFile[]> {
  let previews = MAX_IDS - files.length;
  return Promise.all(files.map(async ({ blob, name, voice_seconds }) => {
    const preview = previews-- > 0 ? await makePreview(blob).catch(() => null) : null;
    return { id: crypto.randomUUID(), key: keyText(), name: name.slice(0, 255), type: blob.type.slice(0, 255), size: blob.size, blob, uploaded_at: null,
      ...preview ? { preview: { id: crypto.randomUUID(), key: keyText(), width: preview.width, height: preview.height }, preview_blob: preview.blob } : {},
      ...voice_seconds !== undefined ? { voice_seconds: Math.min(600, Math.max(0, voice_seconds)) } : {} };
  }));
}

/** Uploaded long enough ago that the server may have deleted it. */
export const uploadExpired = (file: OutgoingFile) => file.uploaded_at !== null && Date.now() - file.uploaded_at > UPLOAD_KEPT_MS;

/** The same file under new ids, to upload again. */
export const renewed = (file: OutgoingFile): OutgoingFile => ({ ...file, id: crypto.randomUUID(), uploaded_at: null,
  ...file.preview ? { preview: { ...file.preview, id: crypto.randomUUID() } } : {} });

/**
 * Encrypts and uploads a file, its preview first; `onProgress` gets 0 to 1 of
 * the file. A retry under the same id is safe.
 * shortcut: one request per file of at most 101 MiB, no resumable upload; an upload session when files grow past that.
 */
export async function uploadFile(conversationId: string, file: OutgoingFile, onProgress: (part: number) => void, signal: AbortSignal) {
  if (file.preview) await chatApi.upload(conversationId, file.preview.id, await encryptFile(file.preview_blob!, fromBase64Url(file.preview.key)), () => undefined, signal);
  const sealed = await encryptFile(file.blob, fromBase64Url(file.key));
  signal.throwIfAborted();
  await chatApi.upload(conversationId, file.id, sealed, sent => onProgress(sent / sealed.size), signal);
}

/** Fetches and decrypts a file (`onProgress` gets 0 to 1) or a preview. */
export async function downloadFile(file: { id: string; key: string; type: string; size: number }, onProgress?: (part: number) => void, signal?: AbortSignal) {
  return decryptFile(await chatApi.download(file.id, signal), fromBase64Url(file.key), file.type, done => onProgress?.(file.size ? Math.min(1, done / file.size) : 1));
}
