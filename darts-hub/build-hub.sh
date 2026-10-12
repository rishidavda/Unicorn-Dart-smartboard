#!/usr/bin/env bash
# Builds WinchesterDarts-win64.zip - the whole hub ready to run on Windows.
# Needs: bash, curl, zip, npm, x86_64-w64-mingw32-gcc
set -euo pipefail
cd "$(dirname "$0")"

NODE_VERSION="${NODE_VERSION:-20.19.5}"
OUT="${OUT:-dist}"
PKG="$OUT/WinchesterDarts"

rm -rf "$OUT"
mkdir -p "$PKG/server" "$PKG/public" "$PKG/runtime" "$PKG/celebrations" "$PKG/data" "$PKG/screen saver"

echo "== 1/5 app files =="
cp package.json "$PKG/"
cp server/*.js "$PKG/server/"
cp -r public/* "$PKG/public/"
mkdir -p "$PKG/public/brand"

echo "== 2/5 dependencies (win32-x64) =="
(cd "$PKG" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --os=win32 --cpu=x64)
# @stoprocent/noble ships prebuilt binaries per platform; keep only Windows.
find "$PKG/node_modules" -type d -name prebuilds | while read -r d; do
  find "$d" -mindepth 1 -maxdepth 1 -type d ! -name 'win32-x64' -exec rm -rf {} +
done
# Windows 10+ uses the WinRT backend, so the HCI-socket transport is dead weight
rm -rf "$PKG/node_modules/@stoprocent/bluetooth-hci-socket" \
       "$PKG/node_modules/usb" "$PKG/node_modules/@serialport" "$PKG/node_modules/serialport" \
       "$PKG/node_modules/@stoprocent/noble/lib/win/src"
find "$PKG/node_modules" \( -name '*.md' -o -name '*.ts' -o -name '*.map' \) -type f -delete
# Docs, tests and licence boilerplate never execute; the zip has a 30MB budget
# (chat delivery) and node.exe eats 28 of it.
find "$PKG/node_modules" -type d \( -name docs -o -name doc -o -name test -o -name tests \
  -o -name example -o -name examples -o -name '.github' \) -prune -exec rm -rf {} +
find "$PKG/node_modules" -type f \( -name 'LICENSE*' -o -name 'LICENCE*' -o -name 'CHANGELOG*' \
  -o -name 'AUTHORS*' -o -name 'CONTRIBUTING*' -o -name '*.markdown' -o -name '.npmignore' \
  -o -name '.eslintrc*' -o -name '.prettierrc*' -o -name 'yarn.lock' \) -delete
rm -f "$PKG/package-lock.json"

echo "== 3/5 portable Node.js =="
curl -fsSL -o "$OUT/node.zip" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip"
unzip -q "$OUT/node.zip" -d "$OUT"
cp "$OUT/node-v${NODE_VERSION}-win-x64/node.exe" "$OUT/node-v${NODE_VERSION}-win-x64/LICENSE" "$PKG/runtime/"
rm -rf "$OUT/node.zip" "$OUT/node-v${NODE_VERSION}-win-x64"

echo "== 4/5 launcher + shortcuts =="
x86_64-w64-mingw32-gcc -O2 -s -o "$PKG/WinchesterDarts.exe" launcher.c -lshell32

cat > "$PKG/settings.ini" <<'EOF'
; The Winchester - darts settings
; PORT and OPEN take effect when the exe is closed and started again;
; DAILY_RESTART and any other line at the next fresh start (next morning).
; Save as plain text (ANSI, UTF-8 or Unicode) - Notepad's defaults are fine.
; Port the hub listens on (change only if 8080 is taken)
PORT=8080
; Which screen to open on THIS pc when the hub starts: tv, pad or none
OPEN=tv
; Daily fresh start: the hub restarts itself at this time each day (24-hour
; clock) so it never runs stale. Nothing is lost and the screens reconnect by
; themselves. A second board on the same PC goes a minute later. OFF (or
; blank) disables.
DAILY_RESTART=09:00
; The dartboard THIS PC always connects to. Not needed: the hub remembers
; the board it finds (or the one you tap on the staff console) by itself.
; To fix it for good, copy the address from the staff console (the board's
; card -> Board & sound -> This oche's dartboard), remove the ; below,
; replace paste-the-address-here with that address and save. Then close the
; black darts window and start the exe again (or leave it: it takes effect
; at the next daily fresh start).
; DARTBOARD=paste-the-address-here
EOF

printf '[InternetShortcut]\r\nURL=http://localhost:8080/\r\n'    > "$PKG/1 - Winchester Darts (open me).url"
printf '[InternetShortcut]\r\nURL=http://localhost:8080/tv\r\n'  > "$PKG/2 - TV screen.url"
printf '[InternetShortcut]\r\nURL=http://localhost:8080/pad\r\n' > "$PKG/3 - Control panel.url"

cat > "$PKG/celebrations/README.txt" <<'EOF'
Drop your own celebration clips in this folder to replace the built-in ones.

Name each file after the moment it should play:

  oneeighty.gif   a maximum 180
  checkout.gif    the winning dart of a leg
  matchwin.gif    winning the match
  legwin.gif      winning a leg
  bust.gif        a bust
  140.gif         a 140+ visit
  100.gif         a 100+ visit
  closed.gif      closing a number in Cricket
  gamewin.gif     winning a game in Tennis (uses legwin.gif if not there)
  decider.gif     the deciding leg

A clip always gets the whole screen, even for a moment that is normally a
slim strap across the top of the scores (a bust, a leg won, a number closed).

GIF, WEBP, PNG all work (not videos). Keep them under a couple of MB so they
pop instantly on the TV. Refresh the TV page after adding files.
EOF

cat > "$PKG/screen saver/README.txt" <<'EOF'
YOUR TV SCREEN SAVER

Put your own pictures and videos in this folder. When nobody has used the
oche for 30 minutes (no darts, no game, no timer, no names typed) the TV
shows every one of them in turn, then starts again from the first:

  - each picture for 10 seconds
  - each video to its end, with the sound off

Anything happening on the oche - a dart, a game started on the iPad, a
timer sold at the bar - brings the game screen straight back. It never
comes on while a timer is running or while the board is switched off.

  Pictures: .jpg .png .gif .webp       Videos: .mp4 .webm

  MP4 (H.264) plays in Chrome or Edge on a Windows PC. A Raspberry Pi or
  other Linux TV browser may only play WebM - make a WebM copy for those.
  A video (or picture) the TV cannot play is simply skipped.

They play in name order, so number them to choose it:
  01-welcome.jpg, 02-drinks-offer.png, 03-quiz-night.mp4 ...

Files added or taken out are picked up by themselves within about 15
seconds - no restart needed; a new one shows when the slideshow reaches
its place in the order. Each PC has its own folder, so each TV can show
something different. A PC restart (or the morning fresh start) does not
count as someone playing - the screen saver carries on.

Change the 30 minutes (0 turns it off) or the 10 seconds on the staff
console: Venue settings -> Screen saver. To check your pictures straight
away: a board's card -> Board & sound -> Show screen saver on TV (the
next dart brings the game back).

Tips: landscape pictures fill a TV best (1920 x 1080). Keep videos to
1080p H.264 MP4 - very large 4K files can stutter on a small PC.
EOF

cp README.md "$PKG/README.md" 2>/dev/null || true

echo "== 5/5 zip =="
(cd "$OUT" && zip -q9r WinchesterDarts-win64.zip WinchesterDarts)
echo "Done: $OUT/WinchesterDarts-win64.zip"
