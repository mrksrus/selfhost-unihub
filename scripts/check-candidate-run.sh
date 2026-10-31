#!/usr/bin/env bash
# Decides whether a candidate-<tree> image may be published without building
# and testing it again (.github/workflows/docker-image.yml, promote). The tag
# alone proves nothing: a publish that failed after writing it would leave it
# behind. The image's io.github.mrksrus.unihub.tested-run label names the run
# that built it. That run must be of docker-image.yml in this repository, the
# latest execution of its publish job must have concluded success, and that
# job's log must show its read-back of exactly this tag naming exactly this
# digest (scripts/verify-image-tags.sh). Anything else, an API error or an
# expired log included, answers no, and the caller builds and tests anew.
#
#   check-candidate-run.sh <candidate tag> <digest> <tested-run label>
#
# Exit 0: proven. Exit 1: not proven, with the reason. Needs GH_TOKEN (actions:
# read) and GITHUB_REPOSITORY.
set -euo pipefail

tag="${1:?usage: check-candidate-run.sh <tag> <digest> <tested-run label>}" digest="${2:?digest}" label="${3-}"
repo="${GITHUB_REPOSITORY:?}"
no() { echo "Not proven: $*" >&2; exit 1; }

[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || no "the digest is '$digest'"
[[ "$label" =~ ^([0-9]+)/([0-9]+)$ ]] || no "the image's tested-run label is '$label'"
run="${BASH_REMATCH[1]}"
path="$(gh api "repos/$repo/actions/runs/$run" --jq .path)" || no "run $run cannot be read"
[[ "$path" == .github/workflows/docker-image.yml* ]] || no "run $run is of $path"
jobs="$(gh api --paginate "repos/$repo/actions/runs/$run/jobs?filter=latest&per_page=100" \
  --jq '.jobs[] | select(.name == "publish") | "\(.id) \(.conclusion)"')" || no "the jobs of run $run cannot be read"
[[ -n "$jobs" && "$(wc -l <<< "$jobs")" -eq 1 ]] || no "run $run has no single publish job"
read -r job conclusion <<< "$jobs"
[ "$conclusion" = success ] || no "the publish job of run $run concluded '$conclusion'"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
gh api "repos/$repo/actions/jobs/$job/logs" > "$log" || no "the log of publish job $job cannot be read"
# The read-back line: "<timestamp> <tag> names <digest>".
awk -v tag="$tag" -v digest="$digest" '{ sub(/\r$/, "") } NF == 4 && $2 == tag && $3 == "names" && $4 == digest { found = 1 } END { exit !found }' "$log" \
  || no "publish job $job of run $run did not read back $tag as $digest"
echo "Proven: publish job $job of run $run read back $tag as $digest"
