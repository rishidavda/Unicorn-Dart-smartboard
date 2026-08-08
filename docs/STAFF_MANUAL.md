# Dartboard System — Staff Manual

How the automatic dartboard scoring rig works, and how to fix it when it misbehaves.
Written for venue staff; the **Tech corner** at the end is for whoever has SSH access to the Raspberry Pi.

---

## 1. How it works (the 60-second version)

```
Unicorn Smartboard ──Bluetooth──▶ Raspberry Pi ──Wi-Fi──▶ TV (spectator view)
   (3×AA batteries)               (bridge + kcapp    └────▶ iPad (controller)
                                   scoring server)
```

1. **The dartboard** (Unicorn Smartboard) senses which segment each dart lands in and sends it over **Bluetooth**. It runs on **3×AA batteries** and has no power switch — the button on the rim means *"end of turn / next player"*, not on/off.
2. **The Raspberry Pi** runs everything: a small *bridge* program that listens to the board over Bluetooth, and the **kcapp** scoring server (web app + database) that keeps score and history.
3. **The TV and the iPad are just web browsers.** The TV shows kcapp's spectator page (big scoreboard); the iPad shows the scoring/controller page (start matches, correct scores, confirm wins). Both get live updates from the Pi over Wi-Fi.

**Why this matters for fixing things:** the Pi sits in the middle. Problems on the *board side* (missed darts, "searching…") are Bluetooth/battery problems. Problems on the *screen side* (TV frozen, iPad won't load) are Wi-Fi/browser problems. If **everything** is dead at once, it's the Pi itself. Decide which side of the Pi the problem is on and you're halfway to fixing it.

Only **one device at a time** can be connected to the board — a phone running a darts app (e.g. Scorebuddy) will silently block the Pi from connecting.

---

## 2. Normal operation

### Starting a match

1. On the iPad, open the kcapp page (keep it bookmarked: `http://<pi-address>:3000`).
2. Create the match — **make sure the venue is selected**. The board only connects for matches at a venue that has a smartboard configured. A match with no venue = the board never connects (and can crash the bridge — see Tech corner).
3. The scoring page opens with the **player order** box. Set the order; optionally tap **Warmup** (this also wakes the board connection).
4. Watch the screen. You should see **"Searching for smartboard …"** then **"Connected to smartboard"**. The board's light changes to its *scoring enabled* state (see light codes in §5).
5. Start the match. Darts now score automatically.

### During play

- **Board button (on the rim):** press it to end a turn / hand over to the next player. Useful when a dart bounced out or a player throws fewer than 3 darts.
- **Bounce-outs and misses** don't register — score them manually on the iPad. (Heads-up: manual corrections mid-turn can occasionally confuse the automatic bust detection for the rest of that turn. Rare, fixes itself next turn.)
- **Winning needs a human.** When a player checks out, a **"Confirm Checkout"** box pops up on the iPad asking how many darts were used — tap **1, 2 or 3**. Until someone taps it, the match looks stuck. That's deliberate (the board occasionally misreads the winning dart).
- **Busts** are handled automatically — no confirmation needed.

### End of match / end of night

- The board disconnects itself when the match finishes (its light returns to the *waiting* state).
- Nothing to switch off on the board — it just goes back to sleep. iPad on charger; TV off if you like.
- If darts started going missing tonight, put in fresh AAs before tomorrow (see §4d).

---

## 3. When scoring breaks: the fix ladder

Find your exact symptom in §4 first. If unsure, work this ladder **top to bottom** — each step is bigger than the last. After each step, retry (reconnect / re-open the match).

| # | Step | How |
|---|------|-----|
| 1 | **Press "Reconnect Smartboard"** | On the iPad scoring page, in the player-order box shown at the start of each leg (keyboard shortcut **R**). Watch for "Searching…" → "Connected". Can't get to the button mid-leg? Go to step 3. |
| 2 | **Check the board** | Throw a dart or press the rim button to wake it. Put in **fresh 3×AA batteries** if darts have been going missing. Make sure nobody's **phone** is connected to the board (darts apps). |
| 3 | **Restart the bridge** | `sudo systemctl restart kcapp-smartboard` — then press Reconnect (step 1). This is the **only** fix when the screen says *"Already Connected"* but darts aren't registering. |
| 4 | **Restart Bluetooth on the Pi** | `sudo systemctl restart bluetooth` — then do step 3 again (the bridge must restart after Bluetooth does). |
| 5 | **Reboot the Pi** | `sudo reboot` — allow ~2 minutes. Fixes bridge, scoring server and TV kiosk in one go. Scores already entered are safe in the database. |
| 6 | **Refresh the screens** | TV: refresh/restart the kiosk browser (or it comes back with the Pi reboot). iPad: pull down to refresh; if still stuck, force-quit Safari and reopen. |
| 7 | **Escalate** | See §6 for what to send the tech. |

Steps 3–5 need SSH (or a keyboard on the Pi). If staff shouldn't have SSH, print step commands for the tech and stop at step 2 + 6.

---

## 4. Symptoms → fixes

### a. "Searching for smartboard …" never goes away

- **Usually:** board asleep or batteries dead · someone's phone is connected to the board · board too far from the Pi · Bluetooth on the Pi is stuck · (after any re-configuration) wrong board UUID in the venue settings.
- **Do:** throw a dart / press the rim button to wake it → fresh batteries → check phones → ladder steps 3–5.
- **Know:** there is **no timeout** — it will search forever without ever showing an error. "Searching…" for more than ~30 seconds means it's not going to find it; start fixing.

### b. Screen says "Already Connected" but darts don't register

- **Usually:** the bridge *thinks* it's still connected because the board vanished without saying goodbye — classic after batteries died or the board lost power mid-match.
- **Do:** **restart the bridge** (ladder step 3), then Reconnect. Pressing "Reconnect Smartboard" alone will **not** fix this — it just says "Already Connected" again.

### c. Scores are wrong but *consistently* wrong (bullseye is right, everything else shifted)

- **Usually:** the board's rotation doesn't match its configuration. The number ring was rotated (e.g. to spread wear on the 20), or the board was swapped/remounted.
- **Do:** rotate the ring back so that the number sitting next to the board's button is the one recorded in the venue settings — or have the tech update **Button Number** in kcapp's venue configuration (§7). The bullseye being correct while everything else is shifted is the giveaway for this exact problem.

### d. Board misses darts, or occasionally registers the wrong segment

- **Usually:** **low batteries** — the manufacturer-known symptom is that detection "gets drastically reduced" as batteries fade. Otherwise: darts in the wire or very edge of a bed.
- **Do:** fresh 3×AA **before** any software troubleshooting. The system cannot see the board's battery level, so batteries are always the first suspect.

### e. Nothing happens at all when a match starts (no "Searching…" message)

- **Usually:** the match was created **without the venue** selected · the venue doesn't have its smartboard enabled in settings · the bridge program is dead.
- **Do:** recreate the match with the correct venue. If that doesn't help: tech checks `systemctl status kcapp-smartboard` and the venue configuration (§7).

### f. Player hit the winning double but the match won't finish

- **Usually:** the **Confirm Checkout** box is waiting on the iPad.
- **Do:** tap the number of darts used (1/2/3). Cancel if the board misread it, then score manually.

### g. TV is black or frozen

- **Usually:** TV's own sleep/eco timer · kiosk browser crashed · Pi is down.
- **Do:** check the TV is on and on the right input. **If the iPad still updates, the Pi is fine** — it's a TV-side problem: restart the kiosk browser or reboot the Pi (ladder 5). Disable the TV's auto-standby/eco timer to prevent repeats.

### h. iPad won't load the page or stopped updating

- **Usually:** iPad hopped onto the wrong Wi-Fi (guest networks often can't reach the Pi even with full bars) · stale page.
- **Do:** pull down to refresh → check Wi-Fi is the venue network → try `http://<pi-address>:3000` in Safari → force-quit Safari and reopen. Keep the page bookmarked / on the Home Screen.

### i. Everything is down (TV, iPad, board)

- **Usually:** the Pi lost power.
- **Do:** check the Pi's power light and cable, reboot it, wait ~2 minutes, then refresh both screens.

---

## 5. Board light codes

**Smartboard V1** (lights in the button):

| Light | Meaning |
|-------|---------|
| Off | No power (batteries dead/missing) |
| Blinking red | Waiting for a connection |
| Solid red | Connected |
| Green | Scoring enabled — healthy mid-match state |

**Smartboard V2** (single green LED):

| Light | Meaning |
|-------|---------|
| Off | No power |
| Rapid double-blink | Waiting for a connection |
| Solid | Connected |
| Slow long blink | Scoring enabled — healthy mid-match state |

---

## 6. Escalating — what to send the tech

1. What the screen said, word for word ("Searching for smartboard…", "Already Connected", nothing at all…).
2. Which ladder steps you tried and what changed.
3. A photo of the TV and of the board's light.
4. If you have SSH: the output of `journalctl -u kcapp-smartboard -n 200 --no-pager`.

---

## 7. Tech corner (SSH tier)

### System layout

| Piece | What | Where |
|-------|------|-------|
| Bridge (this repo) | Node.js process; Bluetooth ↔ kcapp | Pi, e.g. systemd `kcapp-smartboard` |
| kcapp frontend | Web UI + socket.io live updates | Pi, port **3000** |
| kcapp API | Go backend | Pi, port **8001** |
| Database | MySQL | Pi, port 3306 |
| TV | Browser in kiosk mode | `http://<pi>:3000/venues/<venue-id>/spectate` (auto-follows the active match) or `/matches/<id>/spectate` |
| iPad | Safari | `http://<pi>:3000` → match page redirects to `/legs/<leg-id>` (the controller) |

Service names above are the conventional ones (upstream `kcapp/services` ships units for the frontend/API; the smartboard bridge has **no official unit** — the one below is house procedure). Check what this install actually uses: `systemctl list-units 'kcapp*'`.

### Venue configuration (board identity)

In the kcapp web UI: **Offices page → venue form** — `Smartboard` checkbox, `UUID`, `Button Number` (1–20). Stored in MySQL table `venue_configuration` (`has_smartboard`, `smartboard_uuid`, `smartboard_button_number`).

- **UUID format:** the board's Bluetooth MAC address, lowercased, colons stripped — `C4:BE:84:12:34:56` → `c4be84123456`. Exact string match; anything else scans forever.
- **Finding the board's MAC:** `bluetoothctl` → `power on` → `scan on`, then throw a dart to wake the board; look for the *joofunn / Dartboard* device. `scan off` and `exit` **before** starting a match — a competing scan (or a phone app) can keep the bridge from connecting.
- **Button Number** = the segment number physically nearest the board's rim button. The firmware reports segments relative to a fixed orientation; the bridge rotates them in software. Wrong value = every score shifted by a constant amount (bull unaffected).

### Command cheat sheet

```bash
# Bridge / services
systemctl status kcapp-smartboard          # is the bridge running?
sudo systemctl restart kcapp-smartboard    # the big hammer for board issues
journalctl -u kcapp-smartboard -f          # live logs (leave running, reproduce the fault)
journalctl -u kcapp-smartboard -n 200 --no-pager   # recent history
journalctl -u kcapp-smartboard --since "1 hour ago"

# Bluetooth
hciconfig                                  # expect hci0 UP RUNNING
bluetoothctl show                          # expect Powered: yes
sudo systemctl restart bluetooth           # then restart the bridge too
sudo hciconfig hci0 reset                  # adapter soft-reset
rfkill list && sudo rfkill unblock bluetooth

# Network sanity
hostname -I                                # the Pi's IP (give it a DHCP reservation!)
curl -I http://localhost:3000              # frontend answering?
ss -tlnp | grep -E '3000|8001'             # ports listening?
```

### Running the bridge as a service

`/etc/systemd/system/kcapp-smartboard.service`:

```ini
[Unit]
Description=kcapp smartboard bridge
After=network-online.target bluetooth.service
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/smartboard
Environment=NODE_ENV=prod
Environment=KCAPP_API=localhost
Environment=DEBUG=kcapp*
ExecStart=/usr/bin/node kcapp-smartboard.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then: `sudo systemctl daemon-reload && sudo systemctl enable --now kcapp-smartboard`.

Environment variables (all verified against the source):

- `NODE_ENV` must be **exactly** `prod` — anything else (including `production`) loads the *mock* board that reads darts from stdin instead of Bluetooth (`kcapp-smartboard.js:2`).
- `KCAPP_API` — kcapp server host (default `localhost`); `PORT` — default `3000`. Despite the name, the bridge connects to the **frontend's** socket.io, not the Go API.
- `DEBUG=kcapp*` — **without this the bridge logs nothing at all.** A completely silent process is normal-but-undiagnosable; always run the service with DEBUG set.

Healthy startup log: `Waiting for matches to start...`; on match start: `Connected to match N` → `Started scanning for board` → `Found device, stopped scanning` → `Connected to <name> (<uuid>)` → `Enabled listening` → `Subscribed to throw noftifications!` (typo is genuinely in the code) → `Got throw {...}` per dart.

### Bluetooth permissions (non-root)

Noble needs raw HCI access. Either run the service as root, or:

```bash
sudo apt-get install libcap2-bin   # if setcap is missing
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)
getcap $(readlink -f $(which node))   # verify: cap_net_raw=eip
```

**Gotcha:** the capability is attached to that specific node binary — it silently disappears whenever Node is upgraded or switched (apt upgrade, nvm). If the bridge throws permission errors after maintenance, re-run setcap first.

### Known software quirks (verified in the code)

- **No scan timeout.** If the board isn't found, the bridge scans forever; the app shows "Searching for smartboard …" indefinitely with zero errors logged (`smartboard.js`).
- **The "Already Connected" trap.** The bridge's connected-flag is only cleared by a *clean* disconnect. If the board drops unexpectedly (dead batteries, power loss), the flag stays set: every new match — and the Reconnect button — just announces "Already Connected" without rescanning. **Only a bridge restart clears it** (`kcapp-smartboard.js:10,102-106`).
- **A match without a venue crashes the bridge.** `match.venue.config` is read before the null-check (`kcapp-smartboard.js:27-28`); a venueless match throws and can kill the process. `Restart=on-failure` papers over it; still, always create matches with a venue.
- **Bluetooth-off crash.** The bridge never waits for the adapter to be powered before scanning; if Bluetooth is down when a match starts, noble throws. Order the unit `After=bluetooth.service` and restart the bridge after any Bluetooth restart.
- **Battery level is invisible.** `subscribeToBatteryLevel()` exists in `smartboard.js` but is never called — nothing monitors the board's battery. Hence: batteries are always suspect #1.
- **Node/noble version pinning.** The bridge uses `noble@^1.9.1` (unmaintained, native modules from the Node 8–10 era). It will not build/run on modern Node. **Don't upgrade Node on the Pi casually.** If forced, the community drop-in is `@abandonware/noble` (same API; swap the require in `smartboard.js` and the dependency) — and re-run setcap on the new binary.
- **Mock mode for testing.** `npm run dev` (any `NODE_ENV` ≠ `prod`) runs without hardware: type darts at the `Dart:` prompt as `score-multiplier` (`20-3` = treble 20; multipliers: 1 single, 2 double, 3 triple; `exit` quits). Ideal for testing the TV/iPad flow with no board.
- **Ctrl+C takes ~3 s** on the real driver (arity bug in the SIGINT handler; the 3-second fallback timer does the exit). Harmless.
- **Mid-turn manual corrections** can desync the bridge's local X01 bust/checkout tracking for the remainder of that turn (it mirrors scores locally and never re-syncs mid-visit).

---

## 8. Glossary

| Term | Meaning |
|------|---------|
| Bridge | The small program on the Pi (this repo) that translates board Bluetooth into kcapp scores |
| kcapp | The open-source darts scoring system (web app, API, database) |
| Spectator page | The read-only big-scoreboard page the TV shows |
| Controller page | The scoring page on the iPad (start matches, correct scores, confirm checkouts) |
| Visit | One player's turn (up to 3 darts) |
| Leg | One game (e.g. race from 501 to 0); a match is best-of-N legs |
| BLE / Bluetooth LE | The low-energy Bluetooth the board uses; one connected device at a time |
| UUID | The board's identity in venue settings — its MAC address, lowercase, no colons |
