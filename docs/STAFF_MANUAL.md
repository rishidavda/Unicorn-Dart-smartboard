# The Winchester — Darts · Staff Manual

How the interactive darts system works, how to run it day to day, and how to fix it when it misbehaves.
Written for venue staff. The **Tech corner** at the end is for whoever looks after the Windows PC.

> ### Something broken mid-session? Jump straight to:
> - Board connected but darts not counting → **§7a**
> - Every score wrong by the same amount → **§7b**
> - Beeps but no announcer voice → **§7c**
> - TV or iPad page frozen / won't load → **§7d**
> - "Time is up" but the customer has paid for more → **§7e**
> - Forgot the settings PIN → **§7f**
> - Everything dead → **§7g**

---

## 1. How it works (the 60-second version)

```
Unicorn Smartboard ──Bluetooth──▶ Windows PC ──Wi-Fi──▶ TV   (scoreboard + announcer)
   (3×AA batteries)              (WinchesterDarts.exe) └───▶ iPad (control panel)
```

1. **The dartboard** senses where each dart lands and sends it over Bluetooth. It runs on
   **3×AA batteries** in the back and has no power switch — the button on the rim means
   *"next player"*, not on/off. The light on that button matters: **green = scoring,
   red = asleep**.
2. **The Windows PC** runs one program: **WinchesterDarts.exe**. It talks to the board,
   keeps score, plays the announcer, and serves both screens.
3. **The TV and the iPad are just web browsers** pointed at the PC. The exe window shows
   the two addresses to type in (the iPad one has a QR code — point the camera at it).

**Why this matters when fixing things:** the PC sits in the middle. Board-side problems
(darts not counting) are Bluetooth or battery problems. Screen-side problems (frozen page)
are Wi-Fi or browser problems. Everything dead at once = the PC or the exe (§7g).

Only **one device at a time** can talk to the board — a phone running a darts app will
silently block the PC from connecting.

---

## 2. Daily routine

### Opening
1. Turn on the Windows PC. If WinchesterDarts doesn't start by itself, double-click
   **WinchesterDarts.exe**.
2. TV: open the TV address (it usually remembers). **Tap or click the TV page once** —
   browsers keep all sound muted until the screen has been touched. One tap unlocks the
   announcer for the whole day.
3. iPad: open the control panel (or the home-screen icon). Check the top-right pills:
   **board ready** and **connected** are what you want.
4. Throw one dart at the board. If it shows on the TV, you're open.

### Closing
Nothing special — turn things off. Scores, settings, players and any running timer are
saved on the PC and come back after a restart.

---

## 3. The settings PIN

The **Settings** tab on the iPad is staff-only, behind a PIN. **The PIN is 1234 until you
change it.** Enter it once and the tab stays unlocked on that device until you press
**Lock settings now** or close the browser.

- Change it: Settings → *Settings PIN* → type a new 4–8 digit PIN → **Change**.
- Everything else (starting games, fixing scores, players) needs no PIN — customers run
  their own games.

---

## 4. The customer timer

Sell darts by the hour from Settings → **Customer timer**:

1. Take payment at the bar.
2. Settings → **1 hour**, **2 hours**, or type any number of minutes and press **Start**.
3. The clock **starts when their first game starts** — not when you press the button —
   so time isn't eaten walking back to the oche. (If a game is already running, it starts
   immediately.)
4. Both screens show the countdown. It turns red in the last five minutes.
5. At zero: the game they're in finishes normally, but **no new game can start** and both
   screens say to see the bar. **The player list is cleared at zero too**, so the next
   group starts with a fresh list. Sell more time by setting a new timer; **Clear timer**
   removes it entirely (e.g. free play night).

The timer survives a restart of the PC — time sold is time owed.

---

## 5. Running games

Everything happens on the iPad.

- **New game tab**: tap a game card, pick options, tap player names (type new ones —
  they're remembered), **Start game**.
- **Play tab**: everything on one screen — scores, the three-dart slots,
  **Next player / Undo dart / Miss**, and a tap-the-board picture for manual darts
  (bounce-outs, or playing without the smartboard).
- **The board's rim button = next player.** Same as the Next player button on the iPad.
- When a turn ends, the TV holds the player's three darts and total on screen for ten
  seconds so they can see what they scored, and the announcer calls the total.
- **Fix tab**: undo the last dart, correct a score directly, restart or end the game.

### The games
| Game | The idea |
|---|---|
| **X01** (501/301/701) | Race to exactly zero. Double to finish is the pub standard. |
| **Cricket** | Close 15–20 and bull with three marks each; extras score points. |
| **Around the Clock** | Hit 1 to 20 in order, then bull. Great warm-up. |
| **Count-up** | Highest total after 8 rounds. No busts, pure fun. |
| **Killer** | Everyone gets a double. Hit yours to arm; then hit theirs to take lives. Last one standing. |
| **Shanghai** | Round 1 scores on 1s, round 2 on 2s… single+double+treble in one visit wins instantly. |
| **Halve It** | A target each round — miss it with all three darts and your score halves. |

### Sounds
The TV announces every visit total ("One hundred and eighty!"), game shot, bust and
match win — all built in, no internet needed. Test it any time: Settings → **Test caller
on the TV**. If there are beeps but no voice → §7c.

---

## 6. The board

All board controls are in Settings (PIN).

- **Connect board** — scans and connects. Board ID can stay blank (auto-detect).
- **Wake board** — re-sends the "start scoring" signal without reconnecting.
  **Watch the rim button light: green = scoring, red = asleep.**
- **Line up board** — if every score is wrong by the same rotation (you hit 20, it scores
  something else every time): press it, throw one dart into the **20**, done. It works
  out how the board is hung.
- **Board battery** shows under the buttons once connected. Low battery is the number one
  cause of missing or random scores — the rim button keeps working long after the dart
  sensors give up, which is exactly how a flat board fools you. **Three AA cells in the
  back.**
- **Board diagnostics / Copy for support / Select all text** — everything support needs.
  Every check also writes **`WinchesterDarts\diagnostics.txt`** on the PC, so if copying
  from the iPad fights you, send that file instead.

---

## 7. Troubleshooting

### §7a — Board connected but darts not counting
1. **Look at the rim button light.**
   - **Red** → the board is asleep. Settings → **Wake board**, watch it turn green.
   - **Green** → the board thinks it's scoring. Almost always **batteries**: put three
     fresh AA cells in the back. (Unicorn's own guidance: low batteries cause missing and
     random scores while the button still works.)
2. Still nothing? Check the live line under the board buttons while throwing:
   - **DART** entries (green) → the board is fine — is a game actually running? Darts
     don't score with no game on; the TV says so.
   - **BUTTON** only (amber) → the link works but darts don't register: batteries, then
     dart type (brass barely registers — steel or tungsten), then check no dart is stuck
     in the board.
   - Nothing at all → **Disconnect**, then **Connect board** again.
3. Still stuck: **Copy for support** (or grab `diagnostics.txt`) and send it.

### §7b — Every score wrong by the same rotation
The board is hung differently from how the app expects. Settings → **Line up board** →
throw one dart into the big **20**. Fixed permanently.

### §7c — Beeps but no announcer voice
Someone restarted the TV browser and nobody has touched the page since. **Tap or click
the TV page once.** Then Settings → **Test caller on the TV** to confirm.

### §7d — TV or iPad page frozen or won't load
1. Refresh the page (pull down on the iPad; F5 on the TV browser).
2. Check the device is on the venue Wi-Fi (same network as the PC).
3. Check the PC: is the WinchesterDarts window still open? If not, double-click the exe —
   everything (including a running game) comes back as it was.
4. Wrong or forgotten address? It's on the PC's WinchesterDarts window, with a QR code.

### §7e — "Time is up" but they've paid for more
Settings (PIN) → Customer timer → set the new time. A new timer replaces the old one
immediately.

### §7f — Forgot the settings PIN
Tech fix, 1 minute: on the PC, close WinchesterDarts, open `WinchesterDarts\data\settings.json`
in Notepad, find `"adminPin"` and set it back to `"1234"`, save, start the exe again.

### §7g — Everything dead
1. Is the PC on and logged in?
2. Is WinchesterDarts running? Double-click the exe if not.
3. Reboot the PC — everything restores itself, including any customer timer.
4. Still dead: is the venue Wi-Fi up? The screens need it to reach the PC.

---

## 8. FAQ

**Do we need internet?** No. Scoring, the announcer, QR codes — all local. Internet is
only needed the day you install or update the app.

**Customer says "it said BUST but I hit exactly zero."** In X01 with *Double to finish*
on (the default), the last dart must land in a **double**. Hitting zero any other way is
a bust — that's darts, not a fault.

**A dart bounced out / fell off the board.** The board may have scored it or missed it.
Fix tab → **Undo dart**, or add it by tapping the board picture on the Play tab.

**Can they play without the smartboard?** Yes — everything can be entered by tapping the
board picture on the iPad. Same games, same TV, same announcer.

**The board scored a dart nobody threw.** Knocks and vibration can register. Fix tab →
Undo. If it happens a lot, it's nearly always low batteries.

**Two darts landed in the same bed and only one counted?** The board reports a dart
resting in a bed over and over; the app filters repeats closer together than a human can
throw (1.2 seconds). Genuine fast same-bed darts still count — if a 180 ever comes up as
60, tell support.

**Can we change the colours / name on screen?** Settings → Venue and House colours.
The Winchester branding is built in; a `logo.png` dropped into `public\brand` replaces
the crest.

**Can we add our own celebration clips?** Yes — drop a GIF into the `celebrations`
folder on the PC named after the moment: `oneeighty.gif`, `checkout.gif`, `matchwin.gif`,
`bust.gif`, `140.gif`, `100.gif`.

**Can we change the announcer's voice?** Replace the mp3s in `public\sounds` (same file
names). `total-0.mp3` to `total-180.mp3` plus `gameshot`, `bust`, `matchwin`, `legwin`,
`welcome`.

**How many players can join a game?** Up to 8 per game. Names are remembered between
games (long-press a chip to delete one) and the whole list clears itself when the
customer timer runs out, so each group starts fresh.

**Does a PC restart lose the game?** No — the running game, scores, players, settings
and the customer timer all come back.

**What's the Wake board button actually for?** The board falls asleep to save batteries.
The app re-wakes it automatically, but the button forces it right now — watch the rim
light go green.

---

## 9. Tech corner

- **The app**: `WinchesterDarts\WinchesterDarts.exe` — a bundled Node.js server, no
  install, no admin rights. Port **8080**. All state in `WinchesterDarts\data\` (JSON
  files — safe to back up; delete `settings.json` to factory-reset).
- **Screens**: `http://<pc>:8080/tv` and `/pad`; `/` shows both with QR codes;
  `/health` for monitoring; `/api/board-diag` (also `.txt`) for board diagnostics —
  every read also lands in `WinchesterDarts\diagnostics.txt`.
- **Autostart**: put a shortcut to the exe in `shell:startup`. First run: allow it
  through Windows Firewall on **private** networks, and keep the PC's Bluetooth on.
- **Updating**: unzip the new build over the folder — **keep `data\`**. Nothing else to
  migrate.
- **Bluetooth**: Windows 10/11 built-in Bluetooth LE. Don't pair the board in Windows
  settings — the app connects directly. One connection at a time; kill phone darts apps.
- **The board**: Unicorn Smartboard. Service `fff0`; the app writes `0x03` to start
  scoring (rim LED red→green), notifications carry `[segment, multiplier]`;
  `55 AA` = rim button. Battery via the standard battery service. Rotation is a fixed
  ring offset — "Line up board" computes it from one known dart.
- **Support**: Unicorn Customer Service (board hardware): 0115 985 3500, Mon–Fri
  9:00–17:00, or assist@playwiththebest.com.

*Manual updated August 2026 — covers PIN-locked settings, the customer timer, the
announcer, Killer/Shanghai/Halve It, board line-up and battery diagnostics.*
