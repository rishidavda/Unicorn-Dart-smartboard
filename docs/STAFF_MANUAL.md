# Dartboard System — Staff Manual

How the automatic dartboard scoring rig works, and how to fix it when it misbehaves.
Written for venue staff; the **Tech corner** at the end is for whoever has SSH access to the Raspberry Pi
(*SSH = remote login to the Pi from another computer — tech only*).

> **Before printing this:** blanks like **[FILL IN]** are for your venue's details —
> the Pi's address and location, the tech's phone number, which board model you have.
> Fill them in once and this manual becomes self-sufficient.

> ### Something broken mid-match? Jump straight to:
> - "Searching for smartboard…" forever → **§4a**
> - Says "Already Connected" but darts don't count → **§4b**
> - Board scored a dart nobody threw → **§4e**
> - Match won't finish on a winning double → **§4g** (tap Confirm Checkout!)
> - TV or iPad frozen → **§4h / §4i**
> - Everything dead → **§4j / §4k**

---

## 1. How it works (the 60-second version)

```
Unicorn Smartboard ──Bluetooth──▶ Raspberry Pi ──Wi-Fi──▶ TV (spectator view)
   (3×AA batteries)               (bridge + kcapp    └────▶ iPad (controller)
                                   scoring server)
```

1. **The dartboard** (Unicorn Smartboard) senses which segment each dart lands in and sends it over **Bluetooth**. It runs on **3×AA batteries** and has no power switch — the button on the rim means *"end of turn / next player"*, not on/off.
2. **The Raspberry Pi** runs everything: a small *bridge* program that listens to the board over Bluetooth, and the **kcapp** scoring server (web app + database) that keeps score and history. The Pi is the small box located **[FILL IN: e.g. on the shelf behind the TV]**.
3. **The TV and the iPad are just web browsers.** The TV shows kcapp's spectator page (big scoreboard); the iPad shows the scoring/controller page (start matches, correct scores, confirm wins). Both get live updates from the Pi over Wi-Fi.

**Why this matters for fixing things:** the Pi sits in the middle. Problems on the *board side* (missed darts, "searching…") are Bluetooth/battery problems. Problems on the *screen side* (TV frozen, iPad won't load) are Wi-Fi/browser problems. If **everything** is dead at once, it's the Pi or the Wi-Fi (§4j/§4k). Decide which side of the Pi the problem is on and you're halfway to fixing it.

Only **one device at a time** can be connected to the board — a phone running a darts app (e.g. Scorebuddy) will silently block the Pi from connecting.

---

## 2. Normal operation

### Starting a match

1. On the iPad, open the kcapp page. Our address is **http://[FILL IN]:3000** — keep it as a Home Screen icon on the iPad, and written on a sticker on the Pi.
2. On the New Match form, set the **Venue** dropdown to **[FILL IN: your venue name]** — it is easy to leave blank. No venue = the board will never connect, and nothing on screen will tell you why (§4f).
3. The scoring page opens with the **player order** box (the panel listing the players at the start of each leg). Set the order; optionally tap **Warmup** (this also wakes the board connection).
4. Watch the screen. You should see **"Searching for smartboard …"** then **"Connected to smartboard"**. The board's light changes to its *scoring enabled* state (see light codes in §5).
5. Start the match. Darts now score automatically.

### During play

- **Board button (on the rim):** press it to end a turn / hand over to the next player. Useful when a dart bounced out or a player throws fewer than 3 darts.
- **Let the board finish the turn before pulling darts** — press the button (or wait for the third dart to register), *then* pull. Pulling darts early can register as extra throws (§4e).
- **Winning needs a human.** When a player checks out, a **"Confirm Checkout"** box pops up on the iPad asking how many darts were used — tap **1, 2 or 3**. Until someone taps it, the match looks stuck. That's deliberate (the board occasionally misreads the winning dart). Tap **Cancel** if the board misread it, then score by hand.
- **Busts** are handled automatically — no confirmation needed.

> **Scoring by hand / fixing a wrong score.** The board never has the final word — anything it gets
> wrong can be entered or corrected on the iPad scoring page. Bounce-outs and misses don't register,
> so enter those by hand too.
> **[FILL IN for your kcapp version: e.g. "tap the dart to change and re-enter it on the keypad;
> use the undo arrow to remove a phantom dart."]**
> Heads-up: corrections made mid-turn can occasionally confuse the automatic bust detection for the
> rest of that turn; it rights itself next turn.

### End of match / end of night

- The board disconnects itself when the match finishes (its light returns to the *waiting* state).
- Nothing to switch off on the board — it just goes back to sleep. iPad on charger; TV off if you like.
- If darts started going missing tonight, put in fresh AAs before tomorrow (see §4d).

---

## 3. When scoring breaks: the fix ladder

Find your exact symptom in §4 first. If unsure, work this ladder top to bottom.
**Steps 1–3 are yours. Steps 4–6 need the tech** (SSH access to the Pi) — no tech on site? Do 1–3,
keep the game going by scoring manually (§2), and call the tech (§6). Exception: step 6 has a
no-computer method every staff member can do (§4k).

After each step, retry: tap **Reconnect Smartboard** again (step 1). If a page looks broken, go back
to the kcapp home page and **re-open the existing match — do *not* create a new one** (§4f).

| # | Who | Step | How |
|---|-----|------|-----|
| 1 | Staff | **Tap "Reconnect Smartboard"** | On the iPad scoring page, in the player-order box shown at the start of each leg. Watch for "Searching…" → "Connected". Can't get to the button mid-leg? Score manually until the leg ends, then Reconnect — or have the tech do step 4. *(R on an attached keyboard, if you use one.)* |
| 2 | Staff | **Check the board** | Throw a dart or press the rim button to wake it. Fit **fresh 3×AA batteries** if darts have been going missing (spares live **[FILL IN]**). Make sure nobody's **phone** is connected to the board (darts apps). |
| 3 | Staff | **Refresh the screens** | iPad: pull down on the page to refresh; still stuck → force-quit Safari (swipe up from the bottom and hold, then flick the Safari card off the top) and reopen the Home Screen icon. TV: its picture comes from the Pi — a frozen TV page needs the Pi rebooted (step 6). |
| 4 | Tech | **Restart the bridge** | `sudo systemctl restart kcapp-smartboard` — then tap Reconnect (step 1). This is the **only** fix when the screen says *"Already Connected"* but darts aren't registering (§4b). |
| 5 | Tech | **Restart Bluetooth on the Pi** | `sudo systemctl restart bluetooth` — then repeat step 4: the bridge must restart after Bluetooth does. |
| 6 | Tech *or staff* | **Reboot the Pi** | Tech: `sudo reboot`. Staff, no computer needed: unplug the Pi's own power cable (not the TV's), wait 10 seconds, plug it back in (§4k). Either way allow ~2 minutes. Fixes bridge, scoring server and TV in one go. Scores already entered are safe in the database. |
| 7 | — | **Escalate** | See §6 for who to call and what to send. |

---

## 4. Symptoms → fixes

### a. "Searching for smartboard …" never goes away

- **Usually:** board asleep or batteries dead · someone's phone is connected to the board · board too far from the Pi · Bluetooth on the Pi is stuck · (only if someone recently changed settings or swapped the board) the board's ID in the settings no longer matches — a tech job, §7.
- **Do:** throw a dart / press the rim button to wake it → fresh batteries → check phones → ladder steps 4–6.
- **Know:** there is **no timeout** — it will search forever without ever showing an error. "Searching…" for more than ~30 seconds means it's not going to find it; start fixing.

### b. Screen says "Already Connected" but darts don't register

- **Usually:** the bridge *thinks* it's still connected because the board vanished without saying goodbye — classic after batteries died or the board lost power mid-match.
- **Do:** **restart the bridge** (ladder step 4 — tech), then Reconnect. Pressing "Reconnect Smartboard" alone will **not** fix this — it just says "Already Connected" again. No tech on site? Score manually (§2) and have the bridge restarted later.

### c. Scores are wrong but *consistently* wrong (bullseye is right, everything else shifted)

- **Usually:** the board's rotation doesn't match its configuration. The number ring was rotated (e.g. to spread wear on the 20), or the board was swapped/remounted.
- **Do:** our board is configured with **[FILL IN: e.g. 5]** next to the rim button — rotate the number ring until that number sits by the button. If the ring was rotated *on purpose* (spreading wear), the tech must update **Button Number** in kcapp instead (§7).
- **Know:** a correct bullseye with everything else shifted is the giveaway for exactly this problem.

### d. Board misses darts, or occasionally registers the wrong segment

- **Usually:** **low batteries** — the manufacturer-known symptom is that detection "gets drastically reduced" as batteries fade. Otherwise: darts in the wire or very edge of a bed.
- **Do:** fresh 3×AA **before** any software troubleshooting (spares: **[FILL IN]**; the compartment is on the board — no tools needed). The system cannot see the board's battery level, so batteries are always the first suspect.
- **Know:** if the batteries died *during* a match, expect **"Already Connected"** after you change them — that needs the bridge restarted (§4b); fresh batteries alone won't reconnect it.

### e. Board scores darts nobody threw (or scores when darts are pulled out)

- **Usually:** darts pulled out before the turn was ended · the board got knocked or is vibrating · loose mounting.
- **Do:** press the rim button to end the turn **before** pulling darts; remove the phantom score on the iPad (§2 box). If it keeps happening, check the board is firmly on its bracket.

### f. Nothing happens at all when a match starts (no "Searching…" message)

- **Usually:** the match was created **without the venue** selected · the venue's smartboard is disabled in settings · the bridge program is dead.
- **Do:** recreate the match with the correct venue. If that doesn't help: tech checks `systemctl status kcapp-smartboard` and the venue configuration (§7).
- **Related:** if a *second* match got started by accident, the TV can follow the wrong one — end/abandon the stray match on the iPad **[FILL IN: the abandon/cancel action in your kcapp version]**, then Reconnect. Run one smartboard match at a time.

### g. Player hit the winning double but the match won't finish

- **Usually:** the **Confirm Checkout** box is waiting on the iPad.
- **Do:** tap the number of darts used (1/2/3). Cancel if the board misread it, then score manually.

### h. TV is black or frozen

- **Usually:** TV's own sleep/eco timer · the Pi's browser crashed · Pi down.
- **Do:** check the TV is on and on the right input. **If the iPad still updates, the Pi is fine** — the TV picture comes from the Pi itself, so staff can't restart it separately: reboot the Pi (ladder 6, or unplug method §4k) and the TV page comes back on its own. Disable the TV's auto-standby/eco timer to prevent repeats.

### i. iPad won't load the page or stopped updating

- **Usually:** iPad hopped onto the wrong Wi-Fi (guest networks often can't reach the Pi even with full bars) · stale page.
- **Do:** pull down to refresh → check Wi-Fi is the venue network → open **http://[FILL IN]:3000** in Safari → force-quit Safari (swipe up and hold, flick Safari off the top) and reopen. Keep the page as a Home Screen icon.

### j. TV **and** iPad are both dead — but the Pi's light is on

- **Usually:** the Wi-Fi/router is down, not the Pi.
- **Do:** power-cycle the router (**[FILL IN: router location]**), wait ~2 minutes, refresh both screens.

### k. Everything is down (TV, iPad, board — Pi light off)

- **Usually:** the Pi lost power (or someone borrowed its plug).
- **Do:** the Pi is the small box located **[FILL IN]**. Check its power light and cable; to reboot without a computer, unplug the Pi's own power cable, wait 10 seconds, plug it back in, allow ~2 minutes, then refresh both screens. Scores already entered are safe.

---

## 5. Board light codes

Our board is the **[FILL IN: V1 / V2]** — use that table.

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

0. Tech contact: **[FILL IN: name — phone / group chat]**. Send them:
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
| TV | Browser in kiosk mode (*kiosk = the fullscreen browser the Pi runs to drive the TV*) | `http://<pi>:3000/venues/<venue-id>/spectate` (auto-follows the active match) or `/matches/<id>/spectate` |
| iPad | Safari | `http://<pi>:3000` → match page redirects to `/legs/<leg-id>` (the controller) |

Two caveats on names in this manual:

- Service names are the conventional ones — upstream `kcapp/services` ships units for the frontend/API, but the smartboard bridge has **no official unit**; the one below is house procedure. Check what this install actually uses: `systemctl list-units 'kcapp*'`.
- UI locations, shortcuts and URLs (the Reconnect button in the player-order box, the 1/2/3 Confirm Checkout modal, the Offices-page venue form, the spectate/legs URLs) describe the **kcapp frontend as of mid-2026**. They live in the separately-versioned kcapp frontend and can move between versions — if a button isn't where this manual says, check your frontend version, not your sanity.

### Venue configuration (board identity)

In the kcapp web UI: **Offices page → venue form** — `Smartboard` checkbox, `UUID`, `Button Number` (1–20). Stored in MySQL table `venue_configuration` (`has_smartboard`, `smartboard_uuid`, `smartboard_button_number`).

- **UUID format:** the board's Bluetooth MAC address, lowercased, colons stripped — `C4:BE:84:12:34:56` → `c4be84123456`. Exact string match; anything else scans forever.
- **Finding the board's MAC:** `bluetoothctl` → `power on` → `scan on`, then throw a dart to wake the board; look for the *joofunn / Dartboard* device. `scan off` and `exit` **before** starting a match — a competing scan (or a phone app) can keep the bridge from connecting.
- **Button Number** = the segment number physically nearest the board's rim button. The firmware reports segments relative to a fixed orientation; the bridge rotates them in software. Wrong value = every score shifted by a constant amount (bull unaffected). If you change it, update the **[FILL IN]** in §4c too.

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

Reading the logs (with `DEBUG=kcapp*`):

- `Waiting for matches to start...` prints unconditionally at launch — it does **not** prove the kcapp connection succeeded; a bridge that can't reach the frontend prints the same line. The real health indicator is kcapp-sio-client's `Connected to namespace "/active"` line.
- On match start, the healthy sequence is: `Connected to match N` → `Connected to leg N` → `Started scanning for board` → `Found device, stopped scanning` → `Connected to <name> (<uuid>)` → `Enabled listening` → `Subscribed to throw noftifications!` (typo is genuinely in the code) → `Got throw {...}` per dart, interleaved with kcapp-sio-client lines.

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
- **Ctrl+C exits uncleanly** after a board has connected (arity bug in the SIGINT handler — `smartboard.js:189` vs `:128`): expect either an immediate TypeError or, if the board is already gone, a ~3 s wait for the fallback timer. Harmless either way.
- **Mid-turn manual corrections** can desync the bridge's local X01 bust/checkout tracking for the remainder of that turn (it mirrors scores locally and never re-syncs mid-visit).

---

## 8. Glossary

| Term | Meaning |
|------|---------|
| Bridge | The small program on the Pi (this repo) that translates board Bluetooth into kcapp scores |
| kcapp | The open-source darts scoring system (web app, API, database) |
| Spectator page | The read-only big-scoreboard page the TV shows |
| Controller page | The scoring page on the iPad (start matches, correct scores, confirm checkouts) |
| SSH | Remote login to the Pi from another computer — tech only |
| Kiosk | The fullscreen browser the Pi runs to drive the TV |
| Visit | One player's turn (up to 3 darts) |
| Leg | One game (e.g. race from 501 to 0); a match is best-of-N legs |
| BLE / Bluetooth LE | The low-energy Bluetooth the board uses; one connected device at a time |
| UUID | The board's identity in venue settings — its MAC address, lowercase, no colons |
