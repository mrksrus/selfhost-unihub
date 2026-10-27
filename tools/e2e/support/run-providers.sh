#!/usr/bin/env bash
# Runs the real-provider tests (tests/providers) and then deletes every picture,
# video and trace page they left: the runner always keeps a failure screenshot,
# and a screen of a connected real account shows its address and host, which
# text redaction does not reach. Only the report and its summary remain.
#
# Arguments are test files or filters only; options that could move the
# output (--output, --config, ...) are refused, so the cleanup always finds it.
set -uo pipefail
cd "$(dirname "$0")/.."
out=$(realpath -m "${UNIHUB_E2E_PROVIDERS_OUTPUT:-.e2e-providers}")
for arg in "$@"; do
  case $arg in
    -*) echo "run-providers.sh: only test files or filters are accepted (got $arg); set UNIHUB_E2E_PROVIDERS_OUTPUT to change the output" >&2
        exit 2 ;;
  esac
done

clean() {
  rm -rf "$out/results" "$out/videos" "$out/sessions"
  find "$out" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.webm' -o -name '*.zip' -o -name 'trace*' \) -delete 2>/dev/null
}

# The runner and its browsers run in their own process group. A signal to this
# script stops the group (KILL after 20 s if it does not stop), then cleans.
# A signal that arrives before the runner's pid is known is held until it is.
runner= pending=
# The pid is signalled too: a signal can come before the child has called setsid.
group_alive() { ps -eo pid=,pgid=,stat= | awk -v g="$runner" '($1 == g || $2 == g) && $3 !~ /^Z/ { found = 1 } END { exit !found }'; }
stop() {
  if [ -z "$runner" ]; then pending=$1; return; fi
  kill -TERM -- "-$runner" "$runner" 2>/dev/null
  for _ in $(seq 40); do group_alive || break; sleep 0.5; done
  kill -KILL -- "-$runner" "$runner" 2>/dev/null
  wait "$runner" 2>/dev/null
  clean
  exit "$1"
}
trap 'stop 130' INT
trap 'stop 143' TERM
trap 'stop 129' HUP

clean   # pictures a killed earlier run could not remove
setsid ./node_modules/.bin/e2e run --tag providers --target desktop --output "$out" "$@" &
runner=$!
[ -n "$pending" ] && stop "$pending"
wait "$runner"
status=$?
# wait also returns when a trapped signal arrives; stop() has then exited.
runner=
clean
exit $status
