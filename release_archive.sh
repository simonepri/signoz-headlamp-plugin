#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugin_name=signoz-observability-links
version=$(node -p "require('$package_dir/package.json').version")
artifact_name=signoz-headlamp-plugin-$version.tar.gz
output=${1:-"$package_dir/$artifact_name"}

test -s "$package_dir/dist/main.js"
test -s "$package_dir/package.json"

stage=$(mktemp -d "${TMPDIR:-/tmp}/headlamp-signoz-release.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/$plugin_name"
cp "$package_dir/dist/main.js" "$package_dir/package.json" "$stage/$plugin_name/"

# Fixed ownership, ordering, and timestamps make the release archive reproducible.
TZ=UTC touch -t 197001010000 "$stage/$plugin_name/main.js" "$stage/$plugin_name/package.json"

# GNU and BSD tar spell the ownership overrides differently.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  set -- --owner=root:0 --group=root:0
else
  set -- --uid 0 --gid 0 --uname root --gname root
fi

# Building through a pipe would hide a tar failure behind a valid empty gzip.
COPYFILE_DISABLE=1 tar --format ustar "$@" -cf "$stage/archive.tar" -C "$stage" \
  "$plugin_name/main.js" "$plugin_name/package.json"
gzip -n -9 -c "$stage/archive.tar" > "$output"

tar -tzf "$output" > "$stage/listing"
grep -qx "$plugin_name/main.js" "$stage/listing"
grep -qx "$plugin_name/package.json" "$stage/listing"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$output"
else
  shasum -a 256 "$output"
fi
