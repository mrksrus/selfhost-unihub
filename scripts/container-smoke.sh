#!/usr/bin/env bash
# Run only against the disposable MySQL CI service, after loading the local image.
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
  echo 'Container smoke only accepts a loopback MySQL service.' >&2
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
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker image inspect "$image" >/dev/null
# Host networking is intentional for the loopback CI MySQL service. Fail before
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
docker run -d --name "$container_name" --network host \
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
if [[ "$startup_log" == *'MySQL took longer than expected'* || "$startup_log" != *'MySQL is ready!'* ]]; then
  echo 'Database readiness must succeed without exhausting its startup wait.' >&2
  exit 1
fi

docker exec "$container_name" node -e 'if(process.versions.node.split(".")[0]!=="24")process.exit(1);console.log("Runtime Node.js",process.version)'
docker exec "$container_name" ffmpeg -version
docker exec "$container_name" node -e 'const fs=require("node:fs");for(const name of ["LICENSE","LICENSING.md","THIRD_PARTY_NOTICES.md","frontend-dependency-notices.txt","alpine-packages.txt","ffmpeg-license.txt"]){if(!fs.statSync("/app/licenses/"+name).size)throw Error("Empty license notice: "+name)}'
[[ "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.licenses"}}' "$container_name")" == 'PolyForm-Noncommercial-1.0.0' ]]
UNIHUB_SMOKE_CONTAINER="$container_name" node "$script_dir/container-smoke.mjs"
docker exec -i -e UNIHUB_API_ROOT=/app/api "$container_name" node < "$script_dir/../api/tests/helpers/audio-conversion-smoke.cjs"
# Only the disposable container created above is affected. The container must
# exit if its API dies so the deployment's restart policy can recover it.
api_pid="$(docker exec "$container_name" node -e 'const fs=require("node:fs");for(const name of fs.readdirSync("/proc")){if(!/^\d+$/.test(name))continue;try{const args=fs.readFileSync(`/proc/${name}/cmdline`,"utf8").split("\0");if(args.includes("/app/api/server.js")){console.log(name);process.exit(0)}}catch{}}process.exit(1)')"
[[ "$api_pid" =~ ^[0-9]+$ ]] || { echo 'Could not identify disposable container API process.' >&2; exit 1; }
docker exec "$container_name" kill -TERM "$api_pid"
for ((attempt=0; attempt<20; attempt++)); do
  [[ "$(docker inspect --format '{{.State.Running}}' "$container_name")" == false ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Running}}' "$container_name")" == false ]] || { echo 'Container stayed running after API death.' >&2; exit 1; }
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$container_name")" == 1 ]] || { echo 'Container did not report essential service failure.' >&2; exit 1; }
echo 'Container smoke passed: startup, health, authentication, isolation, malformed requests, audio and encrypted backup round-trips, and essential-service recovery.'
