#!/bin/bash
# runall.sh [server.js] [games.js] [app dir]
# Every suite, a fresh hub per hub-based suite. Defaults test the repo; pass
# the paths of an extracted zip to test a packaged build.
#   DARTS_TEST_PORT  base port (default 8899; also uses base-1 and base-2)
#   DARTS_TEST_TMP   where hubs' data and logs go (default /tmp/winchester-test)
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${DARTS_TEST_TMP:-/tmp/winchester-test}"; mkdir -p "$SP"
SRV=${1:-$HERE/../server/server.js}; GAMES=${2:-$HERE/../server/games.js}; APP=${3:-$HERE/..}
BASE=${DARTS_TEST_PORT:-8899}; FAILPORT=$((BASE-1)); CLIPORT=$((BASE-2))
tot_p=0; tot_f=0
report() { local name=$1 log=$2; local line; line=$(grep -E "^[0-9]+ passed, [0-9]+ failed" "$log" | tail -1)
  [ -z "$line" ] && line="0 passed, 1 failed (no summary - crashed?)"
  local p=${line%% passed*}; local f=${line#*, }; f=${f%% failed*}
  tot_p=$((tot_p+p)); tot_f=$((tot_f+f)); printf "%-15s %s\n" "$name" "$line"; grep "^FAIL" "$log" | sed 's/^/    /'; }

GAMES_JS="$GAMES" node "$HERE/gametest.js" > "$SP/ra-engine.log" 2>&1; report engine "$SP/ra-engine.log"

for t in powertest stalelistener visittest tvtest killertv celtiming batch2test nametest2; do
  "$HERE/starthub.sh" raHub "$BASE" "$SRV" > /dev/null || { echo "hub failed for $t"; continue; }
  TPORT="$BASE" DATA_DIR="$SP/raHub" node "$HERE/$t.js" > "$SP/ra-$t.log" 2>&1; report "$t" "$SP/ra-$t.log"
  kill "$(cat "$SP/raHub.pid")" 2>/dev/null; sleep 1
done

# reconnect advice: needs a second hub whose board refuses the link
"$HERE/starthub.sh" raHub "$BASE" "$SRV" > /dev/null
rm -rf "$SP/raHubFail"
FAKE_CONNECT_FAIL=1 SERVER_JS="$SRV" PORT="$FAILPORT" DARTS_DATA="$SP/raHubFail" nohup node "$HERE/fakeboard.js" > "$SP/raHubFail.log" 2>&1 &
echo $! > "$SP/raHubFail.pid"; sleep 2
TPORT="$BASE" TPORT2="$FAILPORT" node "$HERE/troubletest.js" > "$SP/ra-troubletest.log" 2>&1; report troubletest "$SP/ra-troubletest.log"
kill "$(cat "$SP/raHub.pid")" "$(cat "$SP/raHubFail.pid")" 2>/dev/null; sleep 1

for t in recordonce porttest freshedge offcheck boardtest; do
  SERVER_JS="$SRV" node "$HERE/$t.js" > "$SP/ra-$t.log" 2>&1
  if [ "$t" = offcheck ]; then n=$(grep -c "^PASS" "$SP/ra-$t.log"); m=$(grep -c "^FAIL" "$SP/ra-$t.log"); echo "$n passed, $m failed" >> "$SP/ra-$t.log"; fi
  report "$t" "$SP/ra-$t.log"
done
APP_DIR="$APP" TPORT="$CLIPORT" node "$HERE/clienttest.js" > "$SP/ra-clienttest.log" 2>&1; report clienttest "$SP/ra-clienttest.log"
echo "TOTAL: $tot_p passed, $tot_f failed"
[ "$tot_f" -eq 0 ]
