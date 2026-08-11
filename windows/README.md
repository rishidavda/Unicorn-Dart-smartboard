# kcapp smartboard bridge — Windows version

Runs the Unicorn Smartboard ↔ kcapp bridge on a Windows 10/11 PC using the
computer's **built-in Bluetooth** (via `@stoprocent/noble`'s native WinRT
backend — no special dongle, no driver swapping).

The `bridge/` code here is cross-platform — the same code runs on the Pi
(Linux/ARM prebuilds included, Node 18+). For the full
test-on-Windows-then-deploy-to-the-Pi workflow, including the acceptance
test checklist, see [docs/TEST_THEN_DEPLOY.md](../docs/TEST_THEN_DEPLOY.md).

> **Status: experimental.** The package is built and the mock mode is tested,
> but the Bluetooth path has not been validated against a real board from
> Windows. Test with a real board before relying on it for a match night —
> and if it misbehaves, the Raspberry Pi setup remains the known-good path.

## What's in the zip

```
DartboardBridge/
├── DartboardBridge.exe   ← double-click this
├── settings.ini          ← edit this first
├── app/                  ← the bridge + dependencies
└── runtime/              ← portable Node.js (nothing to install)
```

Nothing is installed system-wide; delete the folder to uninstall.

## Setup

1. Unzip `DartboardBridge-win64.zip` somewhere permanent (e.g. `C:\Dartboard`).
2. Edit `settings.ini`:
   - `KCAPP_API` — address of the machine running the kcapp web app.
     `localhost` if this PC runs kcapp too; the Pi's/server's IP otherwise.
   - Leave `PORT=3000` and `DEBUG=kcapp*` alone.
3. Make sure Bluetooth is **on** in Windows Settings, and the PC is within
   ~5 m of the board.
4. **Stop any other bridge first** (e.g. the Pi's: `sudo systemctl stop
   kcapp-smartboard`). Only one device can connect to the board at a time.
5. Double-click `DartboardBridge.exe`. A console window opens and logs
   `Waiting for matches to start...`. Start a match at the smartboard venue
   and watch for `Connected to <name>`.

## Test without the board (do this first)

Set `MODE=mock` in `settings.ini` and run the exe. The bridge connects to
kcapp and gives you a `Dart:` prompt — type darts as `score-multiplier`
(`20-3` = treble 20, multiplier 1/2/3, `exit` quits) and watch them appear
on the TV/iPad. This proves everything except Bluetooth. Set `MODE=board`
back afterwards.

## Finding the board's UUID from Windows

The venue config needs the board's Bluetooth MAC, lowercased, colons
stripped (`C4:BE:84:12:34:56` → `c4be84123456`). With `DEBUG=kcapp*` the
bridge logs every Bluetooth device it discovers while searching
(`Discovered device uuid=... name=...`) — throw a dart to wake the board and
look for the *joofunn / Dartboard* entry. This version also accepts the
colon form in the venue config, and matches on either uuid or address.

## Differences from the Pi bridge

Same scoring logic, plus fixes the Pi version doesn't have (yet):

- Uses `@stoprocent/noble` (maintained, WinRT on Windows, runs on current
  Node) instead of `noble@1.9.1`.
- Waits for the Bluetooth adapter before scanning instead of crashing when
  Bluetooth is off.
- Resets its connected-state if the board drops unexpectedly, announcing
  "Smartboard connection lost — press Reconnect" — the Pi version stays
  stuck on "Already Connected" until restarted.
- Ignores matches with no venue instead of crashing.
- Board identity matches uuid *or* MAC address, with or without colons.

## Auto-start with Windows (optional)

Task Scheduler → Create Basic Task → trigger *When I log on* → action
*Start a program* → browse to `DartboardBridge.exe`. Set "Start in" to the
folder containing the exe.

## Rebuilding the package

From Linux/macOS with node, npm, curl, zip and mingw
(`gcc-mingw-w64-x86-64`) installed:

```bash
./build-win-package.sh          # produces dist/DartboardBridge-win64.zip
```
