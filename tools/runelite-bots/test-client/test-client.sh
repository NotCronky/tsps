#!/usr/bin/env bash
# Runs RuneLite against a worktree's test server, on a virtual display, with the TSPS bot plugins.
#
#   tools/runelite-bots/test-client/test-client.sh <worktree> [display] [user] [password]
#       start (default display :77); with a user and password, the TSPS Test Login plugin logs in
#   tools/runelite-bots/test-client/test-client.sh shot [display] [file]  screenshot the display
#
# The worktree's server and gateway must be running (see docs/runelite-bot-profiles-plan.md).
# Everything RuneLite writes goes under <worktree>/.bot-client (its own home), never ~/.runelite.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO2=${RUNELITE_REPOSITORY:-$HOME/.runelite/repository2}
PATCHER=${RSPROX_LAUNCHER:-$HOME/.rsprox/runelite-launcher}
VERSION=1.13.4

if [ "${1:-}" = shot ]; then
  DISPLAY=${2:-:77} import -window root "${3:-/dev/stdout}"
  exit 0
fi

WORKTREE=$(cd "${1:?usage: test-client.sh <worktree> [display]}" && pwd)
DISPLAY_NUM=${2:-:77}
TEST_USER=${3:-}
TEST_PASSWORD=${4:-}
env_of() { sed -n "s/^$1=//p" "$WORKTREE/.env" | tail -1; }
GATEWAY_PORT=$(env_of GATEWAY_PORT)
WEBSOCKET_PORT=$(env_of WEBSOCKET_PORT)
[ -n "$GATEWAY_PORT" ] && [ "$GATEWAY_PORT" != 43595 ] || { echo "test-client: $WORKTREE has no worktree slot" >&2; exit 1; }
MODULUS=$(sed -n 's/^modulus=//p' "$WORKTREE/gateway/keys/rsa.txt")
[ -n "$MODULUS" ] || { echo "test-client: start the worktree's gateway first (it writes gateway/keys/rsa.txt)" >&2; exit 1; }

HOME_DIR=$WORKTREE/.bot-client
# One test client per worktree: stop an earlier one (a failed start can leave its JVM behind).
for pid in $(pgrep -f "^java -Duser.home=$HOME_DIR " || true); do kill "$pid"; done
mkdir -p "$HOME_DIR/build" "$HOME_DIR/.runelite/sideloaded-plugins" "$HOME_DIR/.rlcustom/sideloaded-plugins"
CP_PATCHER=$(ls "$PATCHER"/*.jar | tr '\n' ':')
javac -proc:none -d "$HOME_DIR/build" -cp "$CP_PATCHER" "$HERE/PatchTestClient.java"
PATCHED=$HOME_DIR/injected-client-$VERSION-gateway-$GATEWAY_PORT.jar
CLIENT=$HOME_DIR/client-$VERSION-local.jar
java -cp "$HOME_DIR/build:$CP_PATCHER" PatchTestClient "$REPO2/injected-client-$VERSION.jar" "$PATCHED" "$GATEWAY_PORT" "$MODULUS" \
  "$REPO2/client-$VERSION.jar" "$CLIENT" "$WEBSOCKET_PORT"

# The bot plugins, built from this checkout.
(cd "$HERE/.." && ./gradlew -q jar)
cp "$HERE/../build/libs/tsps-bots.jar" "$HOME_DIR/.runelite/sideloaded-plugins/"
cp "$HERE/../build/libs/tsps-bots.jar" "$HOME_DIR/.rlcustom/sideloaded-plugins/"

if ! DISPLAY=$DISPLAY_NUM xdpyinfo >/dev/null 2>&1; then
  Xvfb "$DISPLAY_NUM" -screen 0 1280x900x24 -nolisten tcp >"$HOME_DIR/xvfb.log" 2>&1 &
  sleep 1
fi

CP="$PATCHED:$CLIENT"
for jar in "$REPO2"/*.jar; do
  case "$(basename "$jar")" in
    injected-client-*|client-*|*-patched.jar|*1.13.3*|*-natives-windows*|*-natives-macos*) ;;
    *) CP="$CP:$jar" ;;
  esac
done
echo "RuneLite on $DISPLAY_NUM against gateway $GATEWAY_PORT (server $WEBSOCKET_PORT); logs in $HOME_DIR/.runelite/logs"
LOGIN=()
[ -n "$TEST_USER" ] && LOGIN=(-Dtsps.test.username="$TEST_USER" -Dtsps.test.password="$TEST_PASSWORD")
# Discord off twice over (the patched properties, and the client's own switch): the test client
# must never appear in the user's Discord status.
exec env DISPLAY="$DISPLAY_NUM" java -Duser.home="$HOME_DIR" -Drunelite.discord.enable=false -Dtsps.bots.noautostart=true "${LOGIN[@]}" -Xmx768m -Dsun.java2d.opengl=false -cp "$CP" net.runelite.client.RuneLite \
  --developer-mode --disable-telemetry --jav_config="http://127.0.0.1:$WEBSOCKET_PORT/gateway/jav_config.ws"
