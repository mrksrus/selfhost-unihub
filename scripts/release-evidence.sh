#!/usr/bin/env bash
# Moves the release evidence of one CI run between its artifacts
# (.github/workflows/docker-image.yml, evidence job; docs/RELEASE_CONTRACT.md).
#
#   release-evidence.sh fetch <parts dir> <earlier dir>
#     every evidence part of every attempt (unihub-evidence-part-<part>-attempt<n>),
#     each into <parts dir>/<its name>, and the newest bundle an earlier attempt
#     kept (unihub-release-evidence-attempt<n>) into <earlier dir>; none is fine
#   release-evidence.sh clean
#     once this attempt's bundle is stored: deletes the parts and the earlier
#     bundles; fails when this attempt's bundle is not listed
#
# A bundle is only ever stored complete (scripts/collect-release-evidence.mts
# checks it first), so an earlier bundle is complete evidence. Needs GH_TOKEN,
# GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT. Every failed API
# call, download or unpacking stops it with an error: a listing that could not
# be read must never look like a run without evidence.
set -euo pipefail

: "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# "<id> <name>" of every artifact of the run that has not expired.
list() {
  gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?per_page=100" \
    --jq '.artifacts[] | select(.expired | not) | "\(.id) \(.name)"' > "$work/artifacts"
  echo "Artifacts of run $GITHUB_RUN_ID: $(wc -l < "$work/artifacts")"
}
download() { # id directory
  gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$1/zip" > "$work/artifact.zip"
  mkdir -p "$2"
  unzip -q "$work/artifact.zip" -d "$2"
}
bundle_attempt() { # name -> its attempt, if it is a bundle
  [[ "$1" =~ ^unihub-release-evidence-attempt([0-9]+)$ ]] && echo "${BASH_REMATCH[1]}"
}

case "${1:-}" in
  fetch)
    parts="${2:?parts dir}" earlier="${3:?earlier dir}"
    mkdir -p "$parts" "$earlier"
    list
    best=0 best_id=
    while read -r id name; do
      if [[ "$name" =~ ^unihub-evidence-part-.+-attempt[0-9]+$ ]]; then
        echo "Fetching $name"
        download "$id" "$parts/$name"
      elif attempt="$(bundle_attempt "$name")" && (( attempt < GITHUB_RUN_ATTEMPT && attempt > best )); then
        best="$attempt" best_id="$id"
      fi
    done < "$work/artifacts"
    if [[ -n "$best_id" ]]; then
      echo "Fetching unihub-release-evidence-attempt$best (kept by an earlier attempt)"
      download "$best_id" "$earlier"
    else
      echo "No earlier attempt kept a bundle."
    fi
    ;;
  clean)
    list
    grep -qx "[0-9]* unihub-release-evidence-attempt$GITHUB_RUN_ATTEMPT" "$work/artifacts" \
      || { echo "This attempt's bundle is not stored; nothing is deleted." >&2; exit 1; }
    while read -r id name; do
      attempt="$(bundle_attempt "$name" || true)"
      if [[ "$name" == unihub-evidence-part-* ]] || [[ -n "$attempt" && "$attempt" -lt "$GITHUB_RUN_ATTEMPT" ]]; then
        echo "Deleting $name"
        gh api -X DELETE "repos/$GITHUB_REPOSITORY/actions/artifacts/$id"
      fi
    done < "$work/artifacts"
    ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
