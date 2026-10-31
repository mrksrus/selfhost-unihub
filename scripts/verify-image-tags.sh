#!/usr/bin/env bash
# Reads back from the registry every tag a CI job wrote, one per line on
# standard input, and checks that each names the tested image's digest and
# that the digest still resolves (.github/workflows/docker-image.yml, promote
# and publish). Any tag that is missing, unreadable or names another image
# fails the job with an error, so a lost release tag is never silent.
#
#   verify-image-tags.sh <registry>/<name>@<digest> < tags
set -euo pipefail

image="${1:?usage: verify-image-tags.sh <registry>/<name>@<digest> < tags}"
digest="${image##*@}"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::$image does not end in a digest"; exit 1; }
docker buildx imagetools inspect "$image" > /dev/null \
  || { echo "::error::the tested image $image no longer resolves"; exit 1; }

count=0 failed=0
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  count=$((count + 1))
  if ! named="$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' 2>&1)"; then
    echo "::error::$tag cannot be read: $named"
    failed=1
  elif [ "$named" != "$digest" ]; then
    echo "::error::$tag names $named, not the tested $digest"
    failed=1
  else
    echo "$tag names $digest"
  fi
done
(( count > 0 )) || { echo "::error::no tag to verify"; exit 1; }
if (( failed == 0 )) && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "- Verified in the registry: $count tag(s) name \`$digest\`" >> "$GITHUB_STEP_SUMMARY"
fi
exit "$failed"
