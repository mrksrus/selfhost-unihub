#!/usr/bin/env bash
# Installs the synthetic mail and calendar providers of the end-to-end suite
# and the release checks (tools/e2e/stack.sh, scripts/test-providers.mts) on a
# CI runner, and names them in GITHUB_ENV (.github/workflows/docker-image.yml):
# GreenMail from Maven Central (kept in the actions cache under
# greenmail-<version>) and Radicale from PyPI, both pinned and the jar
# checked against its hash. Needs GREENMAIL_VERSION, GREENMAIL_SHA256,
# RADICALE_VERSION, RUNNER_TEMP, GITHUB_ENV and JAVA_HOME_17_X64.
set -euo pipefail
: "${GREENMAIL_VERSION:?}" "${GREENMAIL_SHA256:?}" "${RADICALE_VERSION:?}" "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}" "${JAVA_HOME_17_X64:?}"

jar="$HOME/.cache/unihub-e2e/greenmail/greenmail-standalone-$GREENMAIL_VERSION.jar"
if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  curl --fail --silent --show-error --location -o "$jar.part" \
    "https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/$GREENMAIL_VERSION/greenmail-standalone-$GREENMAIL_VERSION.jar"
  mv "$jar.part" "$jar"
fi
echo "$GREENMAIL_SHA256  $jar" | sha256sum --check
python3 -m venv "$RUNNER_TEMP/radicale"
"$RUNNER_TEMP/radicale/bin/pip" install --quiet "radicale==$RADICALE_VERSION"
{
  echo "UNIHUB_E2E_GREENMAIL_JAR=$jar"
  echo "UNIHUB_E2E_RADICALE=$RUNNER_TEMP/radicale/bin/radicale"
  echo "JAVA=$JAVA_HOME_17_X64/bin/java"
} >> "$GITHUB_ENV"
