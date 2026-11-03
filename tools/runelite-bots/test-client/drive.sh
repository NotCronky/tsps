#!/usr/bin/env bash
# Drives the test client on its virtual display (see test-client.sh, which logs in).
#
#   drive.sh say "<text>"            type into the chat box and press Enter (::commands too)
#   drive.sh click <x> <y>           left-click at screen x, y
#   drive.sh shot <file>             screenshot
#
# DISPLAY_NUM picks the display (default :77). Screen coordinates are the virtual screen's.
set -euo pipefail
export DISPLAY=${DISPLAY_NUM:-:77}
# The client sits centred on the 1280x900 screen; its chat box input is near the bottom left.
CHAT_X=495 CHAT_Y=663
pause() { local i; for ((i = 0; i < $1; i++)); do sleep 0.1; done; }
case "${1:-}" in
  say)
    xdotool mousemove "$CHAT_X" "$CHAT_Y" click 1; pause 2
    xdotool type --delay 40 "$2"; xdotool key Return
    ;;
  click)
    xdotool mousemove "$2" "$3" click 1
    ;;
  shot)
    import -window root "$2"
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
