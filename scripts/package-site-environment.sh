#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment="${1:?usage: package-site-environment.sh uat|production ARCHIVE_PATH [--production-approved]}"
archive="${2:?usage: package-site-environment.sh uat|production ARCHIVE_PATH [--production-approved]}"
approval="${3:-}"

case "$environment" in
  uat)
    hosting="$project_dir/.openai/hosting.json"
    ;;
  production)
    if [[ "$approval" != "--production-approved" ]]; then
      echo "Production packaging requires explicit --production-approved." >&2
      exit 3
    fi
    hosting="$project_dir/.openai/hosting.production.json"
    ;;
  *)
    echo "Unknown environment: $environment" >&2
    exit 2
    ;;
esac

build_dir="$project_dir/dist"
test -f "$build_dir/server/index.js" || {
  echo "Missing dist/server/index.js; run npm run build first." >&2
  exit 2
}
test -f "$hosting" || {
  echo "Missing hosting binding: $hosting" >&2
  exit 2
}

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/dist/.openai"
cp -R "$build_dir"/. "$stage/dist"/
cp "$hosting" "$stage/dist/.openai/hosting.json"
if [[ -d "$project_dir/drizzle" ]]; then
  mkdir -p "$stage/dist/.openai/drizzle"
  cp -R "$project_dir/drizzle"/. "$stage/dist/.openai/drizzle"/
fi

mkdir -p "$(dirname "$archive")"
tar -C "$stage" -czf "$archive" dist
archive_entries="$(tar -tzf "$archive")"
grep -qx 'dist/server/index.js' <<<"$archive_entries"
grep -qx 'dist/.openai/hosting.json' <<<"$archive_entries"

expected_project_id="$(sed -n 's/.*"project_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$hosting")"
packaged_project_id="$(tar -xOzf "$archive" dist/.openai/hosting.json | sed -n 's/.*"project_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [[ -z "$expected_project_id" || "$packaged_project_id" != "$expected_project_id" ]]; then
  echo "Packaged hosting binding does not match $environment." >&2
  exit 4
fi

printf '%s\n' "$archive"
