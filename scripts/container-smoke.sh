#!/usr/bin/env bash
# Run only against the disposable MariaDB CI service, after loading the local image.
set -euo pipefail

if [[ "${CI:-}" != "true" && "${UNIHUB_ALLOW_LOCAL_SMOKE:-}" != "1" ]]; then
  echo 'Container smoke requires CI=true or explicit UNIHUB_ALLOW_LOCAL_SMOKE=1 with a disposable local test database.' >&2
  exit 1
fi
export MYSQL_TEST_HOST="${MYSQL_TEST_HOST:-127.0.0.1}"
export MYSQL_TEST_PORT="${MYSQL_TEST_PORT:-3306}"
export MYSQL_TEST_DATABASE="${MYSQL_TEST_DATABASE:-unihub_test}"
export MYSQL_TEST_USER="${MYSQL_TEST_USER:-unihub_test}"
export MYSQL_TEST_PASSWORD="${MYSQL_TEST_PASSWORD:-test-db-password}"
if [[ "$MYSQL_TEST_HOST" != '127.0.0.1' && "$MYSQL_TEST_HOST" != 'localhost' ]]; then
  echo 'Container smoke only accepts a loopback MariaDB service.' >&2
  exit 1
fi
if [[ ! "$MYSQL_TEST_DATABASE" =~ ^[A-Za-z0-9_]+_test$ ]]; then
  echo 'Container smoke database name must end in _test.' >&2
  exit 1
fi
export BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-ci-admin@example.test}"
export BOOTSTRAP_ADMIN_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD:-ci-bootstrap-password-2026}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-ci-test-encryption-key}"
export BACKUP_MASTER_KEY="${BACKUP_MASTER_KEY:-ci-test-backup-master-key}"
export JWT_SECRET="${JWT_SECRET:-ci-test-jwt-secret-for-container-smoke}"
image="${UNIHUB_SMOKE_IMAGE:-unihub:ci}"
container_name="unihub-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}"
volume_name="${container_name}-uploads"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  local status=$?
  trap - EXIT
  echo 'Container startup and smoke logs:'
  docker logs --tail 100 "$container_name" 2>&1 || true
  docker rm -f "$container_name" "${container_name}-nginx" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker image inspect "$image" >/dev/null
# Host networking is intentional for the loopback CI MariaDB service. Fail before
# starting anything if an unrelated local service owns the image's fixed ports.
node --input-type=module <<'NODE'
import net from 'node:net';
for (const port of [80, 4000]) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`An existing local service is using port ${port}`));
    });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Could not check local port ${port}`));
    });
  });
}
NODE

docker volume create "$volume_name" >/dev/null
# Simulate an uploads volume from before 0.11.1: everything owned by root, a
# private file, and a symlink whose target start.sh must never chown.
docker run --rm --network none --entrypoint sh \
  --mount "type=volume,source=$volume_name,target=/app/uploads" "$image" -c \
  'mkdir -p /app/uploads/legacy-smoke && echo synthetic > /app/uploads/legacy-smoke/file.txt \
    && chmod 600 /app/uploads/legacy-smoke/file.txt && ln -s /etc/passwd /app/uploads/legacy-smoke/link \
    && chown -R -h 0:0 /app/uploads'
# Match the reference Compose security restrictions so Nginx startup is tested
# with its required capabilities, rather than Docker's broader default set.
docker run -d --name "$container_name" --network host \
  --init --cap-drop ALL --security-opt no-new-privileges \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add NET_BIND_SERVICE \
  --cap-add SETGID --cap-add SETUID \
  --mount "type=volume,source=$volume_name,target=/app/uploads" \
  -e NODE_ENV=production \
  -e "MYSQL_HOST=$MYSQL_TEST_HOST" -e "MYSQL_PORT=$MYSQL_TEST_PORT" \
  -e "MYSQL_DATABASE=$MYSQL_TEST_DATABASE" -e "MYSQL_USER=$MYSQL_TEST_USER" -e "MYSQL_PASSWORD=$MYSQL_TEST_PASSWORD" \
  -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD -e ENCRYPTION_KEY -e BACKUP_MASTER_KEY -e JWT_SECRET \
  -e 'MYSQL_STARTUP_MAX_WAIT_SECONDS=60' -e 'MYSQL_STARTUP_CHECK_INTERVAL_SECONDS=2' \
  -e 'UNIHUB_API_START_DELAY_SECONDS=3' "$image" >/dev/null

ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != true ]]; then
    echo 'Container exited before becoming healthy.' >&2
    exit 1
  fi
  if curl --silent --fail --max-time 2 http://localhost/health >/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
[[ "$ready" == 1 ]] || { echo 'Container did not become healthy within 180 seconds.' >&2; exit 1; }
startup_log="$(docker logs "$container_name" 2>&1)"
if [[ "$startup_log" == *'MariaDB took longer than expected'* || "$startup_log" != *'MariaDB is ready!'* ]]; then
  echo 'Database readiness must succeed without exhausting its startup wait.' >&2
  exit 1
fi

# The runtime must be the exact Node.js release the Dockerfile's final stage
# pins (by version and digest), so a rebuild cannot fall back to an older one.
expected_node="$(grep -E '^FROM ' "$script_dir/../Dockerfile" | tail -n 1 | sed -nE 's/^FROM node:([0-9]+\.[0-9]+\.[0-9]+)-alpine@sha256:[0-9a-f]{64}$/\1/p')"
[[ "$expected_node" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'The Dockerfile final stage must be FROM node:<x.y.z>-alpine@sha256:<digest>.' >&2; exit 1; }
docker exec "$container_name" node -e 'if(process.versions.node!==process.argv[1]){console.error("Expected Node.js",process.argv[1],"but the image runs",process.version);process.exit(1)}console.log("Runtime Node.js",process.version)' "$expected_node"
# Mail, CalDAV and push connections trust Node's bundled root certificates.
# The eMudhra intermediates under emSign ECC Root CA - G3 had recoverable keys
# (October 2026); Node 26.12.1 dropped that root, and it must stay dropped.
docker exec "$container_name" node -e '
const { X509Certificate } = require("node:crypto");
const tls = require("node:tls");
const distrusted = "86:A1:EC:BA:08:9C:4A:8D:3B:BE:27:34:C6:12:BA:34:1D:81:3E:04:3C:F9:E8:A8:62:CD:5C:57:A3:6B:BE:6B";
if (tls.rootCertificates.some(pem => new X509Certificate(pem).fingerprint256 === distrusted)) {
  console.error("The image still trusts emSign ECC Root CA - G3.");
  process.exit(1);
}'
# The API must run as the unprivileged unihub user (10001) with no capabilities
# or supplementary groups, and the old root-owned uploads must now belong to it.
api_pid="$(docker exec "$container_name" node -e 'const fs=require("node:fs");for(const name of fs.readdirSync("/proc")){if(!/^\d+$/.test(name))continue;try{const args=fs.readFileSync(`/proc/${name}/cmdline`,"utf8").split("\0");if(args.includes("/app/api/server.js")){console.log(name);process.exit(0)}}catch{}}process.exit(1)')"
[[ "$api_pid" =~ ^[0-9]+$ ]] || { echo 'Could not identify disposable container API process.' >&2; exit 1; }
docker exec -e "SMOKE_API_PID=$api_pid" "$container_name" node -e '
const fs=require("node:fs");const status=fs.readFileSync(`/proc/${process.env.SMOKE_API_PID}/status`,"utf8");
const field=name=>(new RegExp(`^${name}:[ \\t]*(.*)$`,"m").exec(status)||[])[1]?.trim().split(/\s+/).filter(Boolean)||[]; // [ \t]: an empty Groups line must not match the next line
const uid=field("Uid"),gid=field("Gid");
if(uid.length!==4||!uid.every(id=>id==="10001"))throw new Error(`API process must run as uid 10001, got ${uid}`);
if(gid.length!==4||!gid.every(id=>id==="10001"))throw new Error(`API process must run as gid 10001, got ${gid}`);
if(field("Groups").length)throw new Error(`API process must not keep supplementary groups, got ${field("Groups")}`);
if(BigInt("0x"+field("CapEff")[0])!==0n||BigInt("0x"+field("CapPrm")[0])!==0n)throw new Error("API process must not hold capabilities");
for(const target of ["/app/uploads","/app/uploads/legacy-smoke","/app/uploads/legacy-smoke/file.txt"]){const stat=fs.statSync(target);if(stat.uid!==10001||stat.gid!==10001)throw new Error(`${target} was not handed to the API user`)}
if(fs.lstatSync("/app/uploads/legacy-smoke/link").uid!==10001)throw new Error("Symlink in uploads was not handed over");
if(fs.statSync("/etc/passwd").uid!==0)throw new Error("Ownership change followed a symlink out of uploads");
console.log("API runs as uid/gid 10001 without capabilities; uploads handed over");'
docker exec "$container_name" ffmpeg -version
docker exec "$container_name" node -e 'const fs=require("node:fs");for(const name of ["LICENSE","LICENSING.md","THIRD_PARTY_NOTICES.md","frontend-dependency-notices.txt","alpine-packages.txt","ffmpeg-license.txt"]){if(!fs.statSync("/app/licenses/"+name).size)throw Error("Empty license notice: "+name)}'
[[ "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.licenses"}}' "$container_name")" == 'PolyForm-Noncommercial-1.0.0' ]]
# Security headers on every static response: nginx drops inherited add_header
# lines in a location that sets its own, so the cache locations re-include them.
# The page must carry no inline script, which the CSP (script-src 'self') refuses.
# ES module assets (the pdf.js worker) must be served as JavaScript: with
# nosniff a browser refuses to import application/octet-stream.
SMOKE_MODULE_ASSET="$(docker exec "$container_name" sh -c 'cd /usr/share/nginx/html && ls assets/*.mjs | head -n 1')"
[[ "$SMOKE_MODULE_ASSET" == assets/*.mjs ]] || { echo 'The image has no .mjs asset (pdf.js worker) to check.' >&2; exit 1; }
export SMOKE_MODULE_ASSET
node --input-type=module <<'NODE'
async function secured(path) {
  const response = await fetch(`http://localhost${path}`);
  if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
  const csp = response.headers.get('content-security-policy') || '';
  if (!/(^|;)\s*script-src 'self'\s*(;|$)/.test(csp)) throw new Error(`${path} lacks the Content-Security-Policy: ${csp || '(no header)'}`);
  if (response.headers.get('x-content-type-options') !== 'nosniff') throw new Error(`${path} lacks X-Content-Type-Options: nosniff`);
  if (response.headers.get('x-xss-protection') !== '0') throw new Error(`${path} must send X-XSS-Protection: 0`);
  return response;
}
const page = await (await secured('/')).text();
const scripts = [...page.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
if (!scripts.length || scripts.some(attributes => !/\bsrc=/.test(attributes))) throw new Error('index.html must load every script from a file');
if (!scripts[0].includes('/theme-init.js')) throw new Error('index.html must load /theme-init.js first');
const asset = page.match(/\/assets\/[^"']+\.js/)?.[0];
const icon = page.match(/\/icons\/[^"']+/)?.[0];
if (!asset || !icon) throw new Error('index.html names no asset or icon');
for (const path of ['/theme-init.js', '/sw.js', '/manifest.webmanifest', asset, icon]) await secured(path);
console.log(`Security headers present on /, ${asset}, /sw.js, /theme-init.js, the manifest and ${icon}; no inline script`);
const moduleAsset = `/${process.env.SMOKE_MODULE_ASSET}`;
const moduleType = (await secured(moduleAsset)).headers.get('content-type') || '';
if (!/^(text|application)\/javascript\b/.test(moduleType)) throw new Error(`${moduleAsset} is served as ${moduleType || '(no type)'}, not JavaScript`);
console.log(`${moduleAsset} served as ${moduleType}`);
// HSTS only when the proxy in front reports HTTPS; plain HTTP gets none.
const hsts = async headers => (await fetch('http://localhost/', { headers })).headers.get('strict-transport-security');
if (await hsts({})) throw new Error('Plain HTTP must not carry Strict-Transport-Security');
if (await hsts({ 'X-Forwarded-Proto': 'https' }) !== 'max-age=31536000') throw new Error('A request the proxy reports as HTTPS must carry Strict-Transport-Security');
if (!(await (await fetch(`http://localhost${asset}`, { headers: { 'X-Forwarded-Proto': 'https' } })).headers.get('strict-transport-security'))) throw new Error(`${asset} lacks Strict-Transport-Security over HTTPS`);
console.log('Strict-Transport-Security sent only for HTTPS requests');
NODE
# The Android app built into the image: the version handshake offers it and
# Nginx serves the same bytes as an Android package.
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
const version = await (await fetch('http://localhost/api/version')).json();
if (version.app !== 'unihub' || !version.android) throw new Error(`The image must offer the Android app: ${JSON.stringify(version)}`);
const apk = await fetch(`http://localhost${version.android.url}`);
if (apk.status !== 200 || apk.headers.get('content-type') !== 'application/vnd.android.package-archive') throw new Error(`APK download answered ${apk.status} ${apk.headers.get('content-type')}`);
const bytes = Buffer.from(await apk.arrayBuffer());
if (bytes.length !== version.android.size || createHash('sha256').update(bytes).digest('hex') !== version.android.sha256) throw new Error('The served APK does not match its metadata');
console.log(`Android app ${version.android.versionName} offered and served (${bytes.length} bytes)`);
NODE
UNIHUB_SMOKE_CONTAINER="$container_name" node "$script_dir/container-smoke.mts"
docker exec -i -u 10001:10001 -e UNIHUB_API_ROOT=/app/api "$container_name" node --input-type=commonjs-typescript < "$script_dir/../api/tests/helpers/audio-conversion-smoke.cts"
# Contact photos: sharp's prebuilt musl libvips loads, AVIF decodes, and the
# image's FFmpeg turns a HEIC with an irot transform into an upright picture.
docker exec -i -u 10001:10001 -e UNIHUB_API_ROOT=/app/api \
  -e UNIHUB_SMOKE_HEIC_BASE64="$(base64 -w0 "$script_dir/../api/tests/fixtures/contacts/photos/rotated-irot.heic")" \
  "$container_name" node --input-type=commonjs-typescript < "$script_dir/../api/tests/helpers/photo-conversion-smoke.cts"
# Graceful stop: with cap_drop ALL the root supervisor cannot signal the API
# user, so shutdown goes through the IPC channel. It must finish well inside
# Docker's grace period (no SIGKILL) and exit 0.
stop_started=$SECONDS
docker stop -t 30 "$container_name" >/dev/null
(( SECONDS - stop_started < 20 )) || { echo "Graceful stop took $((SECONDS - stop_started))s; the API did not shut down on request." >&2; exit 1; }
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$container_name")" == 0 ]] || { echo 'Container did not exit cleanly on docker stop.' >&2; exit 1; }
docker start "$container_name" >/dev/null
ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if curl --silent --fail --max-time 2 http://localhost/health >/dev/null; then ready=1; break; fi
  sleep 2
done
[[ "$ready" == 1 ]] || { echo 'Container did not become healthy again after restart.' >&2; exit 1; }
api_pid="$(docker exec "$container_name" node -e 'const fs=require("node:fs");for(const name of fs.readdirSync("/proc")){if(!/^\d+$/.test(name))continue;try{const args=fs.readFileSync(`/proc/${name}/cmdline`,"utf8").split("\0");if(args.includes("/app/api/server.js")){console.log(name);process.exit(0)}}catch{}}process.exit(1)')"
[[ "$api_pid" =~ ^[0-9]+$ ]] || { echo 'Could not identify the restarted API process.' >&2; exit 1; }
# Only the disposable container created above is affected. The container must
# exit if its API dies so the deployment's restart policy can recover it.
[[ "$(docker exec "$container_name" cat "/proc/$api_pid/cmdline" | tr '\0' ' ')" == *'/app/api/server.js'* ]] || { echo 'API process changed during smoke.' >&2; exit 1; }
# Signal as the API user: the container's root has no CAP_KILL for uid 10001.
docker exec -u 10001:10001 "$container_name" kill -TERM "$api_pid"
for ((attempt=0; attempt<20; attempt++)); do
  [[ "$(docker inspect --format '{{.State.Running}}' "$container_name")" == false ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Running}}' "$container_name")" == false ]] || { echo 'Container stayed running after API death.' >&2; exit 1; }
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$container_name")" == 1 ]] || { echo 'Container did not report essential service failure.' >&2; exit 1; }
# While the API starts or restarts, Nginx is up and nothing listens on port
# 4000. Run the image's Nginx alone (the app container has exited, so port 80
# is free): API requests must get a 502 with a JSON error, not a 404 that the
# app would read as a missing endpoint, and the page must still load.
docker run -d --name "${container_name}-nginx" --network host \
  --init --cap-drop ALL --security-opt no-new-privileges \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add NET_BIND_SERVICE \
  --cap-add SETGID --cap-add SETUID \
  --entrypoint nginx "$image" -g 'daemon off;' >/dev/null
node --input-type=module <<'NODE'
let page;
for (let attempt = 0; attempt < 30 && page?.status !== 200; attempt++) {
  page = await fetch('http://localhost/').catch(() => undefined);
  if (page?.status !== 200) await new Promise(resolve => setTimeout(resolve, 1000));
}
if (page?.status !== 200) throw new Error(`Nginx without the API: the page answered ${page?.status ?? 'nothing'}`);
for (const path of ['/api/version', '/api/auth/me', '/health']) {
  const response = await fetch(`http://localhost${path}`);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (response.status !== 502 || typeof body?.error !== 'string') throw new Error(`${path} without the API answered ${response.status} ${type}: ${JSON.stringify(body).slice(0, 120)}`);
}
console.log('With the API down, API requests answer 502 with a JSON error and the page still loads');
NODE
docker rm -f "${container_name}-nginx" >/dev/null
echo 'Container smoke passed: startup, non-root API and uploads handover, health, security headers, Android app download, authentication, isolation, malformed requests, audio, contact photo and encrypted backup round-trips, graceful stop, essential-service recovery, and API-down answers.'
