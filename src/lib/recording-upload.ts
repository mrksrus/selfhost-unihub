export interface RecordingChunk {
  offset: number;
  data_base64: string;
  sha256?: string;
}

function uint8ToBase64(bytes: Uint8Array) {
  let binary = '';
  const stride = 0x8000;
  for (let index = 0; index < bytes.length; index += stride) {
    binary += String.fromCharCode(...bytes.subarray(index, index + stride));
  }
  return btoa(binary);
}

export async function uploadRecordingChunks(
  blob: Blob,
  chunkSize: number,
  sendChunk: (chunk: RecordingChunk) => Promise<unknown>,
  onProgress: (percent: number) => void,
) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('Invalid recording chunk size');
  // Only one chunk is copied/hashed at a time, including imported files. This
  // avoids allocating a full recording-sized ArrayBuffer before upload starts.
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const buffer = await blob.slice(offset, offset + chunkSize).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const digest = globalThis.crypto?.subtle
      ? await globalThis.crypto.subtle.digest('SHA-256', buffer)
      : null;
    const sha256 = digest
      ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      : undefined;
    await sendChunk({ offset, data_base64: uint8ToBase64(bytes), sha256 });
    onProgress(Math.round(((offset + bytes.byteLength) / blob.size) * 100));
  }
}
