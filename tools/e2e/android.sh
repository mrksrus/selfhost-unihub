#!/usr/bin/env bash
# The real UniHub Android app in an emulator, connected to an e2e stack
# (tools/e2e/README.md, "Android"). Needs KVM, the Android SDK with an AVD, and
# a running stack instance.
#
#   tools/e2e/android.sh up [--no-build]  boot the emulator, install the debug app, connect it to the stack
#   tools/e2e/android.sh install   rebuild and reinstall the debug app (after Android or web changes)
#   tools/e2e/android.sh down      stop the emulator
#   tools/e2e/android.sh status
#
# Overrides (or ${XDG_CONFIG_HOME:-~/.config}/unihub-e2e/tools.env): ANDROID_HOME,
# ANDROID_AVD_HOME, UNIHUB_E2E_AVD (unihub35), UNIHUB_E2E_EMULATOR_PORT (5560),
# UNIHUB_E2E_EMULATOR_LIBS (a folder with libX11-xcb.so.1 for hosts without it),
# JAVA_HOME, UNIHUB_E2E_INSTANCE, UNIHUB_E2E_EMULATOR_READONLY=1 (boot the AVD read-only, so
# another emulator may run the same AVD at the same time; nothing it installs is kept),
# UNIHUB_E2E_EMULATOR_CORES (2). The app builds without a Gradle daemon, on two workers.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
TOOLS_ENV=${XDG_CONFIG_HOME:-$HOME/.config}/unihub-e2e/tools.env
# shellcheck source=/dev/null
[ -f "$TOOLS_ENV" ] && . "$TOOLS_ENV"
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
AVD=${UNIHUB_E2E_AVD:-unihub35}
EMU_PORT=${UNIHUB_E2E_EMULATOR_PORT:-5560}
SERIAL=emulator-$EMU_PORT
INSTANCE=${UNIHUB_E2E_INSTANCE:-1}
WEB_PORT=$((8087 + INSTANCE))
PACKAGE=io.github.mrksrus.unihub
APK=$REPO/android/app/build/outputs/apk/debug/app-debug.apk
LOG=${TMPDIR:-/tmp}/unihub-e2e-emulator-$EMU_PORT.log
adb() { "$SDK/platform-tools/adb" -s "$SERIAL" "$@"; }
die() { echo "e2e-android: $*" >&2; exit 1; }
booted() { [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; }
# Only the disposable test AVD is ever installed on, wiped or stopped: another
# emulator on this port (someone else's work) is refused.
ours() { [ "$(adb emu avd name 2>/dev/null | head -1 | tr -d '\r')" = "$AVD" ]; }
require_ours() { ours || die "$SERIAL is not the test AVD $AVD; refusing to touch it"; }

build() {
  echo "e2e-android: building the debug app"
  (cd "$REPO/android" && JAVA_HOME=${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")} ./gradlew -q --no-daemon --max-workers=2 -Pkotlin.compiler.execution.strategy=in-process assembleDebug) || die "app build failed"
}

install() {
  require_ours
  if [ "${1:-}" != --no-build ] || [ ! -f "$APK" ]; then build; fi
  # A release build or another signer is replaced: this emulator only holds test data.
  adb install -r "$APK" >/dev/null 2>&1 || { adb uninstall "$PACKAGE" >/dev/null 2>&1 || true; adb install "$APK" >/dev/null; }
  connect
}

connect() {
  require_ours
  # The app allows plain HTTP only for localhost; adb reverse maps the stack's port into the emulator.
  adb reverse "tcp:$WEB_PORT" "tcp:$WEB_PORT" >/dev/null
  adb shell am force-stop "$PACKAGE"
  local prefs="<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name=\"origin\">http://127.0.0.1:$WEB_PORT</string></map>"
  printf '%s' "$prefs" | adb shell "cat > /data/local/tmp/unihub-server.xml"
  adb shell "run-as $PACKAGE mkdir -p shared_prefs && run-as $PACKAGE cp /data/local/tmp/unihub-server.xml shared_prefs/server.xml"
  adb shell am start -n "$PACKAGE/.MainActivity" >/dev/null
  echo "e2e-android: $SERIAL runs the app against http://127.0.0.1:$WEB_PORT"
}

up() {
  [ -r /dev/kvm ] && [ -w /dev/kvm ] || die "no access to /dev/kvm"
  [ -x "$SDK/emulator/emulator" ] || die "Android emulator not found under $SDK"
  if ! booted; then
    local e=$SDK/emulator
    export LD_LIBRARY_PATH="$e/lib64/vulkan:$e/lib64/gles_swiftshader:$e/lib64${UNIHUB_E2E_EMULATOR_LIBS:+:$UNIHUB_E2E_EMULATOR_LIBS}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    echo "e2e-android: booting $AVD on $SERIAL (several minutes on a slow host)"
    setsid "$e/emulator" -avd "$AVD" -port "$EMU_PORT" ${UNIHUB_E2E_EMULATOR_READONLY:+-read-only} -cores "${UNIHUB_E2E_EMULATOR_CORES:-2}" -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim \
      -no-snapshot -no-metrics -memory 2048 -prop ro.hw_timeout_multiplier=3 >"$LOG" 2>&1 < /dev/null &
    for _ in $(seq 1 180); do booted && break; sleep 5; done
    booted || die "emulator did not boot (log: $LOG)"
    # Fewer moving parts while tests drive the screen.
    adb shell settings put global window_animation_scale 0
    adb shell settings put global transition_animation_scale 0
    adb shell settings put global animator_duration_scale 0
  fi
  install "${1:-}"
}

down() {
  booted || { echo "e2e-android: $SERIAL was not running"; return 0; }
  require_ours
  adb emu kill >/dev/null 2>&1 && echo "e2e-android: $SERIAL stopped"
}

status() { booted && echo "e2e-android: $SERIAL running ($(adb shell getprop ro.build.version.release | tr -d '\r'))" || echo "e2e-android: $SERIAL stopped"; }

cmd=${1:-status}; shift || true
case "$cmd" in
  up) up "$@" ;;
  install) install ;;
  connect) connect ;;
  down) down ;;
  status) status ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
