#!/usr/bin/env bash
# Runs the real-provider tests (tests/providers) and then deletes every picture,
# video and trace page they left: the runner always keeps a failure screenshot,
# and a screen of a connected real account shows its address and host, which
# text redaction does not reach. Only the report and its summary remain.
set -uo pipefail
cd "$(dirname "$0")/.."
out=${UNIHUB_E2E_PROVIDERS_OUTPUT:-.e2e-providers}
for arg in "$@"; do
  case $arg in
    --output|--output=*)
      echo "run-providers.sh: set UNIHUB_E2E_PROVIDERS_OUTPUT instead of --output, so the cleanup finds the pictures" >&2
      exit 2 ;;
  esac
done

clean() {
  rm -rf "$out/results" "$out/videos" "$out/sessions"
  find "$out" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.webm' -o -name '*.zip' -o -name 'trace*' \) -delete 2>/dev/null
}

# A stopped run cleans up too: the signal goes to the runner, the cleanup waits
# until it has stopped writing.
runner=
stop() {
  [ -n "$runner" ] && kill -TERM "$runner" 2>/dev/null
  [ -n "$runner" ] && wait "$runner" 2>/dev/null
  clean
  exit "$1"
}
trap 'stop 130' INT
trap 'stop 143' TERM
trap 'stop 129' HUP

./node_modules/.bin/e2e run --tag providers --target desktop --output "$out" "$@" &
runner=$!
wait "$runner"
status=$?
# wait returns early when a trapped signal arrives; the trap has then exited.
runner=
clean
exit $status
