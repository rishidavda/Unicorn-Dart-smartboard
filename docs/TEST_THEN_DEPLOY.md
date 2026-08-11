# Test on Windows, run on the Pi

The workflow for validating the smartboard setup on a Windows machine first,
then moving to the Raspberry Pi for day-to-day use — running the **same bridge
code in both places**, so what you tested is what you run.

```
TEST                                      PRODUCTION
Board ──BT──▶ Windows PC (bridge exe)     Board ──BT──▶ Pi (same bridge, systemd)
                 │ KCAPP_API=<server>                      │ KCAPP_API=localhost
                 ▼                                         ▼
        kcapp server (usually the Pi) ◀── unchanged ──▶ TV + iPad
```

The kcapp server (web app + database) stays wherever it lives — normally the
Pi — through the whole process. Both bridges talk to the same server, so the
venue configuration (board UUID, button number) carries over automatically.
Nothing is migrated.

**The one iron rule: only ever run ONE bridge at a time.** The board accepts a
single Bluetooth connection; two bridges fight over it and both lose.

---

## Phase 0 — prep

1. kcapp server up and reachable: on the Windows machine, browse to
   `http://<server-ip>:3000` — the kcapp page must load.
2. Venue configured in kcapp (Offices page): *Smartboard* ticked, *Button
   Number* set to the segment nearest the board's rim button. UUID can wait
   until test T2 discovers it.
3. **Stop the Pi's bridge** for the duration of testing:
   `sudo systemctl disable --now kcapp-smartboard` (re-enable later).
4. Unzip `DartboardBridge-win64.zip` on the Windows machine (built by
   `windows/build-win-package.sh`; see `windows/README.md`), and set
   `KCAPP_API=<server-ip>` in `settings.ini`.

## Phase 1 — Windows test plan

Work through these in order; each proves a layer. Note what you see —
especially anything flaky — it's the difference between a 5-minute and a
2-hour Pi deployment later.

- [ ] **T1 · Pipeline (no board).** `MODE=mock` in settings.ini, run the exe,
  start a match at the smartboard venue from the iPad, type `20-3` at the
  `Dart:` prompt. **Pass:** treble 20 appears on the TV and iPad.
  *Proves: kcapp connection, venue config, event flow, screens.*
- [ ] **T2 · Board discovery.** `MODE=board`, run, start a match. The console
  logs every Bluetooth device it sees — throw a dart to wake the board and
  find the *joofunn / Dartboard* line. Enter its id in the venue config
  **lowercase, no colons** (`c4be84123456`) — that form works on both the
  Windows and Pi bridges. Press *Reconnect Smartboard* on the iPad.
  **Pass:** "Connected to smartboard" on screen, board light in its
  *scoring enabled* state.
- [ ] **T3 · Scoring accuracy.** Throw a known sequence — single 20, double
  20, treble 20, single 3, bullseye. **Pass:** every value correct. All
  values wrong *by a consistent rotation* (bull still right) = wrong Button
  Number in venue config.
- [ ] **T4 · Turn logic.** Three darts auto-end a visit; the rim button ends
  a short one. **Pass:** turn passes to the next player both ways.
- [ ] **T5 · Checkout.** Play a leg down and check out on a double.
  **Pass:** *Confirm Checkout* appears on the iPad; tapping 1/2/3 finishes
  the leg. Also test *Cancel* + manual correction once.
- [ ] **T6 · Failure drill (worth doing!).** Mid-match, pull one battery out
  of the board. **Pass:** within moments the screen announces *"Smartboard
  connection lost — press Reconnect"*. Reinsert the battery, press
  *Reconnect Smartboard*. **Pass:** board reconnects and scores again.
  *(Note: the original Pi bridge cannot do this — it gets stuck on "Already
  Connected" until restarted, per §4b of the staff manual. This recovery
  only exists in the modern bridge, which is why Option A below deploys it.)*
- [ ] **T7 · Range.** Run the Windows machine from roughly where the Pi will
  actually sit. **Pass:** T3 still passes there.

## Phase 2 — deploy to the Pi

### Option A — deploy the same bridge you just tested (recommended)

The `windows/bridge/` code is cross-platform: its Bluetooth library ships
prebuilt binaries for `linux-arm` and `linux-arm64`, so a Pi 2 or newer
installs it with no compiling. It needs Node 18+ (NodeSource supports Pi 2
and newer; a Pi Zero/1 can't use NodeSource — use Option B there).

```bash
# On the Pi
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
git clone https://github.com/rishidavda/Unicorn-Dart-smartboard.git ~/smartboard
cd ~/smartboard/windows/bridge
npm install --omit=dev
# Bluetooth without root (redo after any Node upgrade):
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)
# Foreground test run first:
DEBUG=kcapp* KCAPP_API=localhost NODE_ENV=prod node kcapp-smartboard.js
```

When the foreground run passes T2, install it as a service —
`/etc/systemd/system/kcapp-smartboard.service`:

```ini
[Unit]
Description=kcapp smartboard bridge
After=network-online.target bluetooth.service
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/smartboard/windows/bridge
Environment=NODE_ENV=prod
Environment=KCAPP_API=localhost
Environment=DEBUG=kcapp*
ExecStart=/usr/bin/node kcapp-smartboard.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kcapp-smartboard
journalctl -u kcapp-smartboard -f     # watch it come up
```

On Linux this bridge uses the same HCI socket route as the original, hence
the `setcap` step and `After=bluetooth.service`.

### Option B — the original upstream bridge

The untouched code at the repo root, on old Node (~8–10) with `noble@1.9.1`
— the long-standing upstream path (see the staff manual's Tech corner for
the unit file). Choose this for a Pi Zero/1, or if you want zero deviation
from upstream kcapp. Know its quirks: the "Already Connected" trap needs a
bridge restart, and a venueless match can crash it — both documented in the
staff manual, both fixed only in Option A.

## Phase 3 — handover checklist

- [ ] Windows bridge closed and **not** set to auto-start.
- [ ] Pi service enabled and running (`systemctl status kcapp-smartboard`).
- [ ] Re-run **T2–T6** against the Pi (~20 minutes). Same code, but
  different Bluetooth stack underneath — worth confirming.
- [ ] Venue config untouched (same server all along — nothing to migrate).
- [ ] Staff manual blanks filled in (Pi location, addresses, tech contact).

**Keep the Windows zip.** If the Pi ever dies on a match night, the Windows
machine *is* the spare bridge: plug in the laptop, run the exe with the same
`settings.ini`, and scoring is back while you fix the Pi — the one time
running the "other" bridge is exactly right, because the Pi's is dead.
