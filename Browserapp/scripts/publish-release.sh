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

gh release upload "$release_tag" "$@" --clobber
gh release edit "$release_tag" --notes-file "$notes_file"
