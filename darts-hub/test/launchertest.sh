#!/bin/bash
# launchertest.sh - the Windows launcher (../launcher.c) under Wine, driven by
# a scripted fake node.exe (launcher-nodestub.c) and a fake browser
# (launcher-browserstub.c). Needs x86_64-w64-mingw32-gcc and wine64; NOT part
# of runall.sh. Scenarios run one at a time (one Wine prefix), ~3 minutes.
#   DARTS_TEST_TMP   work dir (default /tmp/winchester-test); uses its launcher/
#   WINE             wine binary (default /usr/lib/wine/wine64)
#   LAUNCHER_PREFIX  an existing WINEPREFIX to copy instead of making a fresh one
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${DARTS_TEST_TMP:-/tmp/winchester-test}/launcher"; mkdir -p "$SP/runs"
WINE="${WINE:-/usr/lib/wine/wine64}"
export WINEPREFIX="$SP/prefix" WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml=;winemenubuilder.exe=d"
unset DISPLAY PORT OPEN DAILY_RESTART DARTS_DATA CUSTOM WINCHESTER_SUPERVISED WINCHESTER_LAUNCHER_PID
pass=0; fail=0
check() { if [ "$2" = 1 ]; then pass=$((pass+1)); echo "PASS  $1"; else fail=$((fail+1)); echo "FAIL  $1${3:+ — $3}"; fi; }

echo "== build"
build() { [ "$2" -nt "$1" ] && [ -z "$REBUILD" ] || x86_64-w64-mingw32-gcc -O2 -s -o "$2" "$1" -lshell32 || exit 1; }
build "$HERE/../launcher.c" "$SP/WinchesterDarts.exe"
build "$HERE/launcher-nodestub.c" "$SP/node.exe"
build "$HERE/launcher-browserstub.c" "$SP/browser.exe"

echo "== wine prefix"
if [ ! -d "$WINEPREFIX/drive_c" ]; then
  if [ -n "$LAUNCHER_PREFIX" ]; then cp -a "$LAUNCHER_PREFIX" "$WINEPREFIX"
  else "$WINE" wineboot -i > "$SP/wineboot.log" 2>&1 || { echo "wineboot failed"; exit 1; }; fi
fi
mkdir -p "$WINEPREFIX/drive_c/stubs"; cp "$SP/browser.exe" "$WINEPREFIX/drive_c/stubs/browser.exe"
"$WINE" reg add 'HKCR\http' /v 'URL Protocol' /d '' /f > /dev/null 2>&1
"$WINE" reg add 'HKCR\http\shell\open\command' /ve /d '"C:\stubs\browser.exe" "%1"' /f > /dev/null 2>&1

# prep NAME SCENARIO_LINES [NO_NODE]  - a fresh app folder for one scenario
prep() { D="$SP/runs/$1"; rm -rf "$D"; mkdir -p "$D/runtime" "$D/server"
  cp "$SP/WinchesterDarts.exe" "$D/"; [ -z "$3" ] && cp "$SP/node.exe" "$D/runtime/"
  : > "$D/server/server.js"; printf '%b' "$2" > "$D/scenario.txt"; }
# go NAME TIMEOUT_S  - runs the exe (Enter arrives after 1 s), fills $console $stub $browser
go() { D="$SP/runs/$1"; cd "$D" || exit 1; T0=$(date +%s.%N)
  ( sleep 1; printf '\n' ) | timeout -k 5 "$2" "$WINE" "$D/WinchesterDarts.exe" > "$D/console.txt" 2>&1; rc=$?
  elapsed=$(echo "$(date +%s.%N) - $T0" | bc); sleep 0.5
  console=$(tr -d '\r' < "$D/console.txt"); stub=$(cat "$D/stub.log" 2>/dev/null); browser=$(cat "$D/browser.log" 2>/dev/null)
  echo "-- $1: exe rc=$rc elapsed=${elapsed}s"; echo "$console" | grep -v '^$' | sed 's/^/   | /'
  echo "$stub" | sed 's/ argc=.*action=/ action=/; s/^/   /'; [ -n "$browser" ] && echo "$browser" | sed 's/^/   /'; }
runs() { grep -c '^run=' "$D/stub.log" 2>/dev/null; }
field() { grep "^run=$1 " "$D/stub.log" | sed -n "s/.* $2=\(\[[^]]*\]\|<unset>\).*/\1/p"; }   # field RUN KEY
ms() { echo "$1" | awk -F'[:.]' '{ print (($1*60+$2)*60+$3)*1000+$4 }'; }
started() { ms "$(grep "^run=$1 " "$D/stub.log" | sed 's/^run=[0-9]* t=\([^ ]*\).*/\1/')"; }
exited()  { ms "$(grep "^  run=$1 exiting" "$D/stub.log" | sed 's/.* t=//')"; }
gap() { echo $(( $(started "$2") - $(exited "$1") )); }   # ms between run A's exit and run B's start
between() { [ "$1" -ge "$2" ] && [ "$1" -le "$3" ] && echo 1 || echo 0; }
lines() { printf '%b' "$1" | sed 's/$/\r/'; }             # CRLF like Notepad

echo "== scenarios"
# E1/E2: PORT and OPEN stick for the life of the exe; hub keys follow every edit
prep e1-port-sticks 'sleep 3 exit 75 ini2\nexit 75 ini3\nexit 0'
lines 'PORT=8123\nOPEN=tv\nDAILY_RESTART=09:00\nDARTS_DATA=C:\\d1\nCUSTOM=first\n' > "$D/settings.ini"
lines 'PORT=8999\nOPEN=pad\nDAILY_RESTART=10:30\nCUSTOM=second\n' > "$D/settings2.ini"
lines 'OPEN=none\nCUSTOM=third\n' > "$D/settings3.ini"
go e1-port-sticks 30
check 'first run gets settings.ini as written' "$([ "$(field 1 PORT)" = '[8123]' ] && [ "$(field 1 DAILY_RESTART)" = '[09:00]' ] && [ "$(field 1 DARTS_DATA)" = '[C:\d1]' ] && echo 1)" "$(grep '^run=1' "$D/stub.log")"
check 'PORT edited between runs: relaunched hub keeps the original PORT' "$([ "$(field 2 PORT)" = '[8123]' ] && echo 1)" "$(field 2 PORT)"
check 'PORT line deleted: third run still on the original PORT' "$([ "$(field 3 PORT)" = '[8123]' ] && echo 1)" "$(field 3 PORT)"
check 'DAILY_RESTART edit reaches the relaunch' "$([ "$(field 2 DAILY_RESTART)" = '[10:30]' ] && echo 1)" "$(field 2 DAILY_RESTART)"
check 'DAILY_RESTART line deleted: unset again (hub default 09:00)' "$([ "$(field 3 DAILY_RESTART)" = '<unset>' ] && echo 1)" "$(field 3 DAILY_RESTART)"
check 'removed DARTS_DATA line is gone from the relaunched hub' "$([ "$(field 2 DARTS_DATA)" = '<unset>' ] && [ "$(field 3 DARTS_DATA)" = '<unset>' ] && echo 1)" "$(field 2 DARTS_DATA)"
check 'other hub keys follow every edit' "$([ "$(field 2 CUSTOM)" = '[second]' ] && [ "$(field 3 CUSTOM)" = '[third]' ] && echo 1)"
check 'browser opened once, on the original port and page, never on a relaunch' "$([ "$(grep -c BROWSER "$D/browser.log")" = 1 ] && grep -q 'http://localhost:8123/tv' "$D/browser.log" && echo 1)" "$browser"
check 'fresh start: relaunch after ~1 s' "$(between "$(gap 1 2)" 800 3000)" "$(gap 1 2)ms"
prep e1-shell-value 'sleep 3 exit 75 ini2\nexit 0'
lines 'OPEN=none\nCUSTOM=fromfile\nDAILY_RESTART=OFF\n' > "$D/settings.ini"
lines 'OPEN=none\nCUSTOM=fromfile\n' > "$D/settings2.ini"
CUSTOM=fromshell DAILY_RESTART=08:00 go e1-shell-value 30
check 'settings.ini overrides a key the shell set' "$([ "$(field 1 CUSTOM)" = '[fromfile]' ] && [ "$(field 1 DAILY_RESTART)" = '[OFF]' ] && echo 1)" "$(grep '^run=1' "$D/stub.log")"
check 'line deleted: the shell value comes back, not nothing' "$([ "$(field 2 DAILY_RESTART)" = '[08:00]' ] && [ "$(field 2 CUSTOM)" = '[fromfile]' ] && echo 1)" "$(grep '^run=2' "$D/stub.log")"

# T3: a long shell-inherited value (past launcher.c's own 1024-byte probe
# buffer) must round-trip intact when its settings.ini override is removed,
# not be silently wiped to NULL because the probe once mistook "too long to
# fit" for "was never set"
LONGVAL=$(printf 'x%.0s' $(seq 1 1030))
SHORTVAL=$(printf 'x%.0s' $(seq 1 1023))
prep e1-shell-value-long 'sleep 3 exit 75 ini2\nexit 0'
lines 'OPEN=none\nCUSTOM=fromfile\n' > "$D/settings.ini"
lines 'OPEN=none\n' > "$D/settings2.ini"
CUSTOM="$LONGVAL" go e1-shell-value-long 30
check 'settings.ini overrides a 1030-char shell value' "$([ "$(field 1 CUSTOM)" = "[fromfile]" ] && echo 1)" "$(field 1 CUSTOM)"
check 'line deleted: the 1030-char shell value comes back intact, not wiped' "$([ "$(field 2 CUSTOM)" = "[$LONGVAL]" ] && echo 1)" "len=$(field 2 CUSTOM | wc -c)"
prep e1-shell-value-boundary 'sleep 3 exit 75 ini2\nexit 0'
lines 'OPEN=none\nCUSTOM=fromfile\n' > "$D/settings.ini"
lines 'OPEN=none\n' > "$D/settings2.ini"
CUSTOM="$SHORTVAL" go e1-shell-value-boundary 30
check 'one byte under the boundary: the 1023-char shell value comes back intact too' "$([ "$(field 2 CUSTOM)" = "[$SHORTVAL]" ] && echo 1)" "len=$(field 2 CUSTOM | wc -c)"

# E3: encodings
prep e3-utf16le 'sleep 3 exit 0'
{ printf '\xff\xfe'; lines 'PORT=8124\nOPEN=none\nDAILY_RESTART=OFF\nCUSTOM=w\xc3\xa9\n' | iconv -f UTF-8 -t UTF-16LE; } > "$D/settings.ini"
go e3-utf16le 20
check 'UTF-16 LE settings.ini (PowerShell >) is read' "$([ "$(field 1 PORT)" = '[8124]' ] && [ "$(field 1 DAILY_RESTART)" = '[OFF]' ] && [ -z "$browser" ] && echo 1)" "$(grep '^run=1' "$D/stub.log")"
check 'UTF-16 LE: no warning' "$(echo "$console" | grep -q WARNING && echo 0 || echo 1)"
prep e3-utf16be 'sleep 3 exit 0'
{ printf '\xfe\xff'; lines '; comment\nPORT=8125\nDAILY_RESTART=OFF\n' | iconv -f UTF-8 -t UTF-16BE; } > "$D/settings.ini"
go e3-utf16be 20
check 'UTF-16 BE settings.ini is read' "$([ "$(field 1 PORT)" = '[8125]' ] && [ "$(field 1 DAILY_RESTART)" = '[OFF]' ] && echo 1)" "$(grep '^run=1' "$D/stub.log")"
prep e3-utf8bom 'sleep 3 exit 0'
{ printf '\xef\xbb\xbf'; lines 'PORT=8126\nOPEN=none\nDAILY_RESTART=07:15\n'; } > "$D/settings.ini"
go e3-utf8bom 20
check 'UTF-8 with BOM still read' "$([ "$(field 1 PORT)" = '[8126]' ] && [ "$(field 1 DAILY_RESTART)" = '[07:15]' ] && echo 1)" "$(grep '^run=1' "$D/stub.log")"
prep e3-utf16le-nobom 'sleep 3 exit 0'   # an editor's "UCS-2 LE", a script's default: no BOM, comment first like the shipped file
lines '; comment\nPORT=8127\nOPEN=none\nDAILY_RESTART=OFF\n' | iconv -f UTF-8 -t UTF-16LE > "$D/settings.ini"
go e3-utf16le-nobom 20
check 'UTF-16 LE without a BOM, comment line first: read' "$([ "$(field 1 PORT)" = '[8127]' ] && [ "$(field 1 DAILY_RESTART)" = '[OFF]' ] && [ -z "$browser" ] && echo 1)" "$(grep '^run=1' "$D/stub.log")"
check 'UTF-16 LE without a BOM: no warning' "$(echo "$console" | grep -q WARNING && echo 0 || echo 1)"
prep e3-utf16be-nobom 'sleep 3 exit 0'
lines '; comment\nPORT=8128\nOPEN=none\nDAILY_RESTART=OFF\n' | iconv -f UTF-8 -t UTF-16BE > "$D/settings.ini"
go e3-utf16be-nobom 20
check 'UTF-16 BE without a BOM, comment line first: read' "$([ "$(field 1 PORT)" = '[8128]' ] && [ "$(field 1 DAILY_RESTART)" = '[OFF]' ] && [ -z "$browser" ] && echo 1)" "$(grep '^run=1' "$D/stub.log")"
prep e3-unreadable 'sleep 3 exit 0'   # UTF-32: NULs everywhere, and the first line is a comment so nothing is "odd" on its own
lines '; comment\nPORT=8129\nDAILY_RESTART=OFF\n' | iconv -f UTF-8 -t UTF-32LE > "$D/settings.ini"
go e3-unreadable 20
check 'unreadable settings.ini (NULs, comment first): clear warning on the console' "$(echo "$console" | grep -q 'WARNING: settings.ini' && echo 1 || echo 0)" "$console"
check 'unreadable settings.ini: defaults used, hub still starts' "$([ "$(field 1 PORT)" = '[8080]' ] && [ "$(field 1 DAILY_RESTART)" = '<unset>' ] && echo 1)"
prep e3-edge-cases 'sleep 3 exit 0'
lines '; comment\n# PORT=1111\n\n  port = 9000  \n\topen\t=\tpad\nDAILY_RESTART = 06:30\nCUSTOM=a=b\nnoequals line\nPORT=\n' > "$D/settings.ini"
go e3-edge-cases 20
check 'spacing, case, comments, blank PORT= as before' "$([ "$(field 1 PORT)" = '[9000]' ] && [ "$(field 1 DAILY_RESTART)" = '[06:30]' ] && [ "$(field 1 CUSTOM)" = '[a=b]' ] && grep -q 'localhost:9000/pad' "$D/browser.log" && echo 1)" "$(grep '^run=1' "$D/stub.log")"
check 'one odd line among good ones: no warning' "$(echo "$console" | grep -q WARNING && echo 0 || echo 1)"

# E4: the browser opens only if the hub is still up after 2.5 s
prep e4-in-use 'exit 64'
go e4-in-use 20
check 'code 64 at once: NO browser window, stop with "Press Enter"' "$([ -z "$browser" ] && [ "$(runs)" = 1 ] && [ "$rc" = 64 ] && echo "$console" | grep -q 'stopped (code 64)' && echo "$console" | grep -q 'Press Enter' && echo 1)" "rc=$rc"
prep e4-normal 'sleep 5 exit 0'
go e4-normal 20
check 'normal start: browser opens once, maximised, ~2.5 s in' "$([ "$(grep -c BROWSER "$D/browser.log")" = 1 ] && grep -q 'localhost:8080/tv' "$D/browser.log" && grep -q 'wShowWindow=3' "$D/browser.log" && [ "$(between "$(( $(ms "$(sed 's/^BROWSER t=\([^ ]*\).*/\1/' "$D/browser.log")") - $(started 1) ))" 2000 4500)" = 1 ] && echo 1)" "$browser"
prep e4-setup-error 'sleep 1 exit 2'
go e4-setup-error 20
check 'setup error within 2.5 s: no browser, stop' "$([ -z "$browser" ] && [ "$(runs)" = 1 ] && [ "$rc" = 2 ] && echo 1)" "rc=$rc"
# the window is owed to the first hub that survives 2.5 s, not to the first launch
opened_after() { between "$(( $(ms "$(sed 's/^BROWSER t=\([^ ]*\).*/\1/' "$D/browser.log")") - $(started "$1") ))" 2000 4500; }   # opened ~2.5 s into run N
prep e4-no-port-first 'exit 78\nsleep 5 exit 0'
go e4-no-port-first 60
check 'first launch exits 78 (no free port), retry survives: one browser window, opened on the retry' "$([ "$(runs)" = 2 ] && [ "$(grep -c BROWSER "$D/browser.log")" = 1 ] && [ "$(opened_after 2)" = 1 ] && echo 1)" "runs=$(runs) $browser"
prep e4-fresh-start-first 'sleep 1 exit 75\nsleep 5 exit 0'
go e4-fresh-start-first 20
check 'first launch exits 75 at 1 s, relaunch survives: one browser window, opened on the relaunch' "$([ "$(runs)" = 2 ] && [ "$(grep -c BROWSER "$D/browser.log")" = 1 ] && [ "$(opened_after 2)" = 1 ] && echo 1)" "runs=$(runs) $browser"

# unchanged behaviours
prep r-no-port 'exit 78\nexit 0'
go r-no-port 60
check 'code 78: retry after 30 s' "$([ "$(runs)" = 2 ] && [ "$(between "$(gap 1 2)" 29000 34000)" = 1 ] && echo "$console" | grep -q '30 seconds' && echo 1)" "$(gap 1 2)ms"
prep r-fast-crash 'sleep 3 exit 3'
go r-fast-crash 20
check 'crash within 60 s: stop and show it' "$([ "$(runs)" = 1 ] && [ "$rc" = 3 ] && echo "$console" | grep -q 'stopped (code 3)' && echo 1)" "rc=$rc runs=$(runs)"
prep r-late-crash 'sleep 61 exit 3\nexit 0'
go r-late-crash 100
check 'crash after 60 s: relaunch after ~5 s, then a clean stop' "$([ "$(runs)" = 2 ] && [ "$(between "$(gap 1 2)" 4500 8000)" = 1 ] && [ "$rc" = 0 ] && echo "$console" | grep -q 'restarting in 5 seconds' && echo 1)" "$(gap 1 2)ms rc=$rc"
check 'relaunch never opens another browser' "$([ "$(grep -c BROWSER "$D/browser.log")" = 1 ] && echo 1)" "$browser"
prep r-missing-node 'exit 0' nonode
go r-missing-node 20
check 'no runtime\node.exe: explains and waits for Enter' "$([ "$rc" = 1 ] && echo "$console" | grep -q 'could not start' && echo 1)" "rc=$rc"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
