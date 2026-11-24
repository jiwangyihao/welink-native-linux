#!/bin/bash
# Dedicated offline Xvfb runner. Arguments: an Electron executable, assembled app root.
# No user's DISPLAY, D-Bus session, application profile, or network namespace is reused.
set -euo pipefail
if (( $# != 2 )); then echo "usage: $0 ELECTRON ASSEMBLED_APP" >&2; exit 2; fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
electron=$(realpath -- "$1")
application=$(realpath -- "$2")
profile=$(mktemp -d /tmp/welink-native-render-run-XXXXXX)
mkdir -m 700 "$profile/home" "$profile/runtime"
exec unshare --net --mount --propagation private env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
  -u SESSION_MANAGER HOME="$profile/home" XDG_RUNTIME_DIR="$profile/runtime" WELINK_RENDER_TEST_DISPLAY=isolated \
  xvfb-run -a -s '-screen 0 1280x960x24 -nolisten tcp +extension Composite' \
  bash -c 'set -euo pipefail; openbox >"$4/openbox.log" 2>&1 & wm=$!; trap '\''kill "$wm" 2>/dev/null || true'\'' EXIT; "$1" --no-sandbox "$2" "$3"' \
  surface-verifier "$electron" "$here/meeting_render_surface_verify.js" "$application" "$profile"
