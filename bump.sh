#!/bin/bash
# Bump the OSAWARE cachebuster / build number in one shot.
# Reads the current value from VERSION, generates a fresh Unix timestamp,
# replaces all occurrences in index.html and core/drivers/terminal.js,
# and writes the new value back to VERSION.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f VERSION ]; then
  echo "error: VERSION file not found in $(pwd)" >&2
  exit 1
fi

OLD=$(cat VERSION | tr -d '[:space:]')
NEW=$(date +%s)

if [ -z "$OLD" ]; then
  echo "error: VERSION is empty" >&2
  exit 1
fi

if [ "$OLD" = "$NEW" ]; then
  echo "error: new timestamp matches old ($OLD); wait a second and retry" >&2
  exit 1
fi

sed -i '' "s/$OLD/$NEW/g" index.html core/drivers/terminal.js
echo "$NEW" > VERSION

# Regenerate files/INDEX — manifest of disk-loadable program names
# (one bare name per line, no .bas extension). VFS loadFromFilesDir
# uses this to skip network fetches for unknown program names, so
# the browser doesn't 404 on RUN <typo>.
if [ -d files ]; then
  ls files/*.bas 2>/dev/null | xargs -n1 basename | sed 's/\.bas$//' | sort > files/INDEX
fi

echo "Build bumped: $OLD → $NEW"
