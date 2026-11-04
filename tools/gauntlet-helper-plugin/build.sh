#!/usr/bin/env bash
# Builds the Gauntlet Helper RuneLite plugin against the RuneLite jars already in
# ~/.runelite/repository2 and installs it into ~/.rlcustom/sideloaded-plugins (where this
# RuneLite loads them; override with PLUGIN_DIR).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$HOME/.runelite/repository2"
out="$here/build"
jar="$out/gauntlet-helper.jar"

pick() { ls "$repo"/$1 2>/dev/null | grep -v -- -patched | sort -V | tail -1; }
client="$(pick 'client-*.jar')"
api="$(pick 'runelite-api-*-runtime.jar')"
[ -n "$client" ] && [ -n "$api" ] || { echo "RuneLite jars not found in $repo; start RuneLite once first." >&2; exit 1; }
cp="$client:$api:$(pick 'guice-*.jar'):$(pick 'javax.inject-*.jar'):$(pick 'slf4j-api-*.jar')"

rm -rf "$out"
mkdir -p "$out/classes"
javac --release 11 -nowarn -cp "$cp" -d "$out/classes" $(find "$here/src" -name '*.java')
jar --create --file "$jar" -C "$out/classes" .

if [ "${1:-}" != "--no-install" ]; then
  dest="${PLUGIN_DIR:-$HOME/.rlcustom/sideloaded-plugins}"
  mkdir -p "$dest"
  cp "$jar" "$dest/"
  echo "Installed $dest/gauntlet-helper.jar (built against $(basename "$client"))"
fi
