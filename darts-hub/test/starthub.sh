#!/bin/bash
# starthub.sh <name> <port> [server.js]
# Boots a hub with the fake Bluetooth board and records node's OWN pid in
# $SP/<name>.pid (a backgrounded "cd && node" list would record the subshell).
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${DARTS_TEST_TMP:-/tmp/winchester-test}"; mkdir -p "$SP"
NAME=$1; PORT=$2; SERVER=${3:-$HERE/../server/server.js}
if [ -f "$SP/$NAME.pid" ]; then kill "$(cat "$SP/$NAME.pid")" 2>/dev/null; sleep 1; fi
rm -rf "$SP/$NAME"
SERVER_JS="$SERVER" PORT="$PORT" DARTS_DATA="$SP/$NAME" nohup node "$HERE/fakeboard.js" > "$SP/$NAME.log" 2>&1 &
echo $! > "$SP/$NAME.pid"
for i in $(seq 1 20); do grep -q "is running" "$SP/$NAME.log" && break; sleep 0.5; done
if grep -q "taken" "$SP/$NAME.log"; then echo "ERROR: port $PORT busy"; kill "$(cat "$SP/$NAME.pid")"; exit 1; fi
echo "hub $NAME up on $PORT (pid $(cat "$SP/$NAME.pid"))"
