#!/usr/bin/env bash
set -euo pipefail

release_tag=${1:?release tag is required}
notes_file=${2:?release notes file is required}
shift 2

if [[ "$#" -eq 0 ]]; then
  echo "at least one release asset is required" >&2
  exit 2
fi
if [[ ! -f "$notes_file" ]]; then
  echo "release notes file not found: $notes_file" >&2
  exit 2
fi

repo=${GH_REPO:-}
if [[ -z "$repo" ]]; then
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi

asset_id_by_name() {
  local name=$1
  gh release view "$release_tag" --repo "$repo" --json assets \
    --jq ".assets[] | select(.name == \"$name\") | .id" 2>/dev/null | head -n 1 || true
}

delete_asset() {
  local id=$1
  if [[ -z "$id" ]]; then
    return 0
  fi
  gh api -X DELETE "repos/$repo/releases/assets/$id" >/dev/null 2>&1 || true
}

upload_one() {
  local asset=$1
  local name
  local attempt
  name=$(basename "$asset")
  for attempt in 1 2 3 4 5; do
    # Large uploads can time out after the server already stored the bytes;
    # clearing the stale record first keeps retries idempotent.
    delete_asset "$(asset_id_by_name "$name")"
    if gh release upload "$release_tag" "$asset" --repo "$repo" --clobber; then
      return 0
    fi
    echo "upload attempt $attempt failed for $name" >&2
    sleep $((attempt * 10))
  done
  echo "failed to upload $name after retries" >&2
  return 1
}

for asset in "$@"; do
  upload_one "$asset"
done

# Release notes and publication state are finalized once by the workflow terminal job after every required asset exists.
