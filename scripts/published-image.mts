// Files of a published UniHub release, read from its container image in the
// registry without Docker: the Android app (/app/downloads) and the built web
// app (/usr/share/nginx/html). Only the one image layer that holds them is
// downloaded. Anonymous pull access is enough for the public image.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const IMAGE_REPOSITORY = process.env.UNIHUB_IMAGE_REPOSITORY || 'ghcr.io/mrksrus/selfhost-unihub';

/** Which Dockerfile step wrote the files, and where they are in the image. */
export const PUBLISHED_PARTS = {
  android: { createdBy: /COPY \/out\/ \/app\/downloads\//, prefix: 'app/downloads/' },
  web: { createdBy: /COPY \/build\/dist \/usr\/share\/nginx\/html/, prefix: 'usr/share/nginx/html/' },
} as const;

interface Descriptor { mediaType: string; digest: string; size: number; platform?: { os: string; architecture: string } }
const MANIFESTS = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');

async function registry(repository: string) {
  const [host, ...rest] = repository.split('/');
  const name = rest.join('/');
  const tokenResponse = await fetch(`https://${host}/token?scope=repository:${name}:pull`, { signal: AbortSignal.timeout(30000) });
  if (!tokenResponse.ok) throw new Error(`${host}: no pull token (${tokenResponse.status})`);
  const { token } = await tokenResponse.json() as { token: string };
  return async (url: string, accept?: string) => {
    const response = await fetch(`https://${host}/v2/${name}/${url}`, { headers: { Authorization: `Bearer ${token}`, ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(300000) });
    return response;
  };
}

/** Regular files of a tar stream under prefix, by path relative to it. */
function untar(archive: Buffer, prefix: string) {
  const files = new Map<string, Buffer>();
  let longName: string | null = null;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const name = longName ?? (field(345, 155) ? `${field(345, 155)}/${field(0, 100)}` : field(0, 100));
    const body = archive.subarray(offset + 512, offset + 512 + size);
    longName = null;
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') {
      const pathRecord = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (pathRecord) longName = pathRecord[1];
    } else if ((type === '0' || type === '7') && name.startsWith(prefix)) {
      const relative = name.slice(prefix.length);
      if (relative && !relative.split('/').some(part => part === '..' || part === '')) files.set(relative, Buffer.from(body));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export interface PublishedFiles { version: string; image: string; digest: string; files: Map<string, Buffer> }

/** Returns null when the release has no such image or the image has no such files. */
export async function readPublishedFiles(version: string, part: keyof typeof PUBLISHED_PARTS, repository = IMAGE_REPOSITORY): Promise<PublishedFiles | null> {
  const { createdBy, prefix } = PUBLISHED_PARTS[part];
  const get = await registry(repository);
  let response = await get(`manifests/${version}`, MANIFESTS);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${repository}:${version}: manifest ${response.status}`);
  let digest = response.headers.get('docker-content-digest') || '';
  let manifest = await response.json() as { manifests?: Descriptor[]; config: Descriptor; layers: Descriptor[] };
  if (manifest.manifests) {
    const amd64 = manifest.manifests.find(item => item.platform?.os === 'linux' && item.platform.architecture === 'amd64');
    if (!amd64) throw new Error(`${repository}:${version} has no linux/amd64 image`);
    response = await get(`manifests/${amd64.digest}`, MANIFESTS);
    digest = amd64.digest;
    manifest = await response.json() as typeof manifest;
  }
  const config = await (await get(`blobs/${manifest.config.digest}`)).json() as { history: { created_by?: string; empty_layer?: boolean }[] };
  const withLayers = config.history.filter(entry => !entry.empty_layer);
  if (withLayers.length !== manifest.layers.length) throw new Error(`${repository}:${version}: image history and layers disagree`);
  const index = withLayers.findIndex(entry => createdBy.test(entry.created_by || ''));
  if (index < 0) return null;
  const layer = manifest.layers[index];
  const blob = Buffer.from(await (await get(`blobs/${layer.digest}`)).arrayBuffer());
  if (`sha256:${crypto.createHash('sha256').update(blob).digest('hex')}` !== layer.digest) throw new Error(`${repository}:${version}: layer digest mismatch`);
  if (/zstd/.test(layer.mediaType)) throw new Error(`${repository}:${version}: zstd layers are not supported`);
  const files = untar(/gzip/.test(layer.mediaType) ? zlib.gunzipSync(blob) : blob, prefix);
  return files.size ? { version, image: `${repository}:${version}`, digest, files } : null;
}

export function writeFiles(files: Map<string, Buffer>, directory: string) {
  const root = path.resolve(directory);
  for (const [relative, bytes] of files) {
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new Error(`Refusing ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}
