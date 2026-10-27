#!/usr/bin/env bash
# Runs the real-provider tests (tests/providers) and then deletes every picture,
# video and trace page they left: the runner always keeps a failure screenshot,
# and a screen of a connected real account shows its address and host, which
# text redaction does not reach. Only the report and its summary remain.
set -uo pipefail
cd "$(dirname "$0")/.."
out=${UNIHUB_E2E_PROVIDERS_OUTPUT:-.e2e-providers}
npx e2e run --tag providers --target desktop --output "$out" "$@"
status=$?
rm -rf "$out/results" "$out/videos" "$out/sessions"
find "$out" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.webm' -o -name '*.zip' -o -name 'trace*' \) -delete 2>/dev/null
exit $status
