# Test harness

Everything here runs the **real hub** (`../server/server.js`) with a fake
Bluetooth board (`fakeboard.js` — behaves like a Unicorn Smartboard and
throws a dart every 2 seconds once connected) and drives the **real pages**
in Chromium. Nothing in this folder ships in the zip.

```bash
cd darts-hub/test
npm install                 # playwright-core + socket.io-client (pinned)
./runall.sh                 # every suite against the repo (~12 min)
./runall.sh /path/to/extracted/WinchesterDarts/server/server.js \
            /path/to/extracted/WinchesterDarts/server/games.js \
            /path/to/extracted/WinchesterDarts     # same, against a packaged build
node soak.js                # 25-minute continuous play + power cycles (SOAK_MIN=60 for longer)
node restarttest.js         # the 09:00 fresh start, end to end (~12 min)
node multiday.js            # three simulated pub days at 20x clock speed (~2.5 h; needs `faketime`)
./scheduled-soak.sh         # what the unattended check-ins run: runall + restart + soak, one summary
```

Environment: `DARTS_TEST_TMP` (hub data + logs, default `/tmp/winchester-test`),
`DARTS_TEST_PORT` (base port for `runall.sh`, default 8899; it also uses base−1
and base−2), `TPORT` (port for a single suite), `CHROMIUM_PATH`
(default `/opt/pw-browsers/chromium`), `FAKE_CONNECT_FAIL=1` (the fake board
refuses connections — used by `troubletest.js`). `fakeboard.js` lists more
opt-in knobs (slow connects, refuse-then-accept, noble's disconnect event, a
second board, an HTTP hook to drop the link) — `boardtest.js` uses them.

| Suite | What it proves |
|---|---|
| `gametest.js` | Every game and variant, dart by dart: Prisoner, Killer (both variants), Count-up, X01 busts/double-in, cut-throat Cricket, plus a random-play sweep of all 24 games |
| `powertest.js` | Power off/on: billing, standby screens, refusals, persistence, reconnect, ALL buttons, keep-awake |
| `stalelistener.js` | A released or powered-off board can never score |
| `visittest.js` | Announcer specials and the quiet-caller flag over the socket |
| `tvtest.js`, `killertv.js`, `celtiming.js`, `batch2test.js` | The TV and pad pages: card order and timing, Killer flow, Fix-tab corrections, pad toasts |
| `nametest2.js` | Names can be typed before staff start the timer; the closed sign covers only the Play tab |
| `padtest.js` | The pad between groups: the last group's line-up never carries over, the closed banner on every tab, "No game running" on the Fix controls, long toasts fit the screen |
| `troubletest.js` | Reconnect advice on the staff card (just released / wake it / one device at a time / refused link) |
| `boardtest.js` | Board link robustness: Disconnect/Power off racing a Connect or a slow link, a refused link retried by itself, a second Connect press, tapping the other board, the board dropping the link |
| `recordonce.js` | A finished game is recorded exactly once across restarts; crash-safe saves recover a torn file |
| `porttest.js`, `freshedge.js`, `offcheck.js` | Sticky ports for two boards on one PC; fresh-start settings, single-instance lock, launcher-gone pause, midnight rollover |
| `clienttest.js` | Screens reload once after an upgrade (never on a plain restart), staff taps during a restart, keep-awake re-arms, leaderboard retries |
| `launchertest.sh` | The Windows exe (`../launcher.c`) under Wine with a scripted fake `node.exe` and browser: `PORT`/`OPEN` stick for the life of the exe while hub keys follow every `settings.ini` edit (deleted lines really go), UTF-8-BOM and UTF-16 files, the "no settings found" warning, no TV window when the hub has already stopped, the 75/78/64/crash relaunch timings. Needs mingw + wine; **not part of `runall.sh`** (~3 min) |
