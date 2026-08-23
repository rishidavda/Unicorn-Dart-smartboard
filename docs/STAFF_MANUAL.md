# The Winchester — Darts · Staff Manual

How the interactive darts system works, how to run it day to day — including several
boards at once — and how to fix it when it misbehaves. The **Tech corner** at the end is
for whoever looks after the PCs.

> ### Something broken mid-session? Jump straight to:
> - Board connected but darts not counting → **§7a**
> - Every score wrong by the same amount → **§7b**
> - Beeps but no announcer voice → **§7c**
> - TV or iPad page frozen / won't load → **§7d**
> - Customers say they can't start a game → **§7e**
> - Forgot the settings PIN → **§7f**
> - A board shows "offline" on the staff console → **§7g**
> - Everything dead → **§7h**

---

## 1. How it works (the 60-second version)

```
Board 1: Smartboard ─BT─▶ PC 1 ─Wi-Fi─▶ TV 1 + players' iPad 1
Board 2: Smartboard ─BT─▶ PC 2 ─Wi-Fi─▶ TV 2 + players' iPad 2   ─┐
Board 3: Smartboard ─BT─▶ PC 3 ─Wi-Fi─▶ TV 3 + players' iPad 3    ├─▶ ONE staff iPad (/staff)
                                                                  ─┘    ONE leaderboard (/board)
```

- **Each oche is one PC** running `WinchesterDarts.exe`: it talks to its own dartboard
  over Bluetooth, keeps score, plays the announcer, and serves its own TV and players'
  iPad. Boards are independent — one PC off never stops the others.
- **The staff iPad runs every board.** Bookmark `/staff` on the **main** PC: one page,
  one PIN, a card per board — timers, extends, board fixes, venue settings for all.
- **The leaderboard merges every board**: top 50 this month, all-time records.
- **The players' iPads have no settings at all.** Everything staff-only lives on the
  staff console.
- The dartboard runs on **3×AA batteries**, has no power switch, and its rim button
  means *next player*. The light on that button: **green = scoring, red = asleep**.

**The rule of thumb when fixing:** darts not counting = Bluetooth or batteries on that
board's PC. Frozen page = Wi-Fi or browser. One card "offline" on the staff console =
that board's PC. Everything dead = network.

## 2. Setting up multiple boards (one-time)

For each oche: PC + TV + iPad, all on the venue Wi-Fi.

1. On each PC, unzip the app to `C:\WinchesterDarts` and run **WinchesterDarts.exe**.
   If a PC must run two hubs, change `PORT=` in `settings.ini` — normally leave it.
2. Note each PC's address from its screen page (e.g. `http://192.168.1.51:8080`).
   Give the PCs **fixed IPs** in the router so the addresses never change.
3. Pick a **main PC**. On its `/staff` page → *This venue's boards* → **Add** the other
   PCs' addresses.
4. On each board's card, use **Rename** so they're "Board 1", "Board 2", "Board 3" (or
   "Front oche" — whatever staff say out loud).
5. Bookmark the **main PC's** `/staff` on the till iPad and `/board` wherever the
   leaderboard lives. Done — one PIN unlocks every board (set the same PIN everywhere;
   changing it from the staff console updates all boards at once).

Each board's own screens stay as before: its `/tv` on its TV, its `/pad` on its
players' iPad.

## 3. The staff console (`/staff`)

PIN-protected (default **1234** — change it). Locks itself 30 seconds after the screen
is left. One card per board:

- **Timer**: 1 hour / 2 hours / custom **Start**, **+15 / +30 / custom** extend,
  **End now**, **Clear**. The big clock shows each board's state at a glance.
- **Now playing**: the game and scores on that board right now.
- **Board & sound** (fold-out): Connect / Wake / Disconnect, **Line up board**,
  **Test caller on TV**, a link to that board's diagnostics report, and Rename.
- **Venue settings** (bottom): name, tagline, town, house colours and the PIN —
  applied to **every board at once**.

## 4. Selling time — how a session works

**Customers cannot start a game until staff put time on the clock.** Between sessions
the players' iPad shows *"Ready when you are — see the bar to get started."*

1. Take payment at the bar.
2. On that board's card: **1 hour**, **2 hours**, or custom → **Start**.
3. The players' iPad unlocks instantly. The countdown **starts when their first game
   starts** — not when you press the button — and shows on every screen, red in the
   last five minutes.
4. **At zero the oche closes itself**: the game ends, the player names clear, and the
   players' iPad shows *"Time's up — see the bar"* until the next timer. Nothing
   carries over between groups.
5. Mid-session: **+15/+30/custom** to sell more (extending an expired session reopens
   the oche), **End now** for the group that left early, **Clear** to remove the timer.

Timers survive a PC restart — time sold is time owed.

## 5. The leaderboard (`/board`)

Merged across every board, live:

- **This month · top 50** by wins (games played and win % shown; ties broken by win
  rate). Resets automatically each calendar month.
- **All time**: the top 10 by wins, plus the record books — **best visit**, **most 180s
  in one game**, **quickest X01 win**.
- **Latest results** labelled by board.

Read-only and safe anywhere — a spare telly or a customer's phone. If a board's PC is
off, the page says whose games are missing and picks them up when it returns.

## 6. Running games (the players' iPad)

Three tabs — **Play / New game / Fix** — and no settings to fiddle with.

- **New game**: tap a game card, options, tap player names (typed once, remembered
  until the session ends), **Start game**.
- **Play**: one screen — scores, dart slots, **Next player / Undo dart / Miss**, and a
  tap-the-board picture for bounce-outs or smartboard-free play.
- **The board's rim button = next player.**
- Turn ends: the TV holds the three darts and total for ten seconds; the announcer
  calls it ("One hundred and eighty!"). Game shot, bust and match win have their own
  calls. Test from the staff console → *Board & sound* → **Test caller**.
- **Fix**: undo the last dart, set a score directly, restart or end the game.

| Game | The idea |
|---|---|
| **X01** (501/301/701) | Race to exactly zero. Double to finish is the default. |
| **Cricket** | Close 15–20 and bull with three marks; extras score points. |
| **Around the World** | Hit 1→20 in order, then bull. **Triples only** variant: only the treble moves you on. |
| **Count-up** | Highest total after 8 rounds. No busts. |
| **Killer** | Hit your own double to arm, then hit theirs to take lives. |
| **Shanghai** | Round N scores on N. Single+double+treble in one visit wins instantly. |
| **Halve It** | A target each round — miss with all three darts and your score halves. |

## 7. Troubleshooting

### §7a — Board connected but darts not counting
1. **Look at that board's rim button light.** Red → staff console → that board's card →
   *Board & sound* → **Wake board**; watch it turn green. Green → almost always
   **batteries**: three fresh AA cells in the back. (Unicorn's own guidance: low
   batteries cause missing and random scores while the button still works.)
2. Still nothing → **Disconnect**, then **Connect**.
3. Still stuck → the card's **diagnostics report** link; send what it shows. A copy is
   also saved as `diagnostics.txt` next to that PC's exe.

### §7b — Every score wrong by the same rotation
That board's card → *Board & sound* → **Line up board** → throw one dart into the big
**20**. Fixed permanently.

### §7c — Beeps but no announcer voice
Someone restarted that TV's browser and nobody has touched the page since. **Tap that
TV's page once**, then **Test caller** from the staff console.

### §7d — TV or players' iPad frozen or won't load
1. Refresh the page (pull down on iPad; F5 on the TV).
2. Same Wi-Fi as that board's PC?
3. Is WinchesterDarts running on that PC? Double-click the exe — everything comes back.
4. The address (with QR) is on that PC's screen page.

### §7e — Customers say they can't start a game
That's the system working: **no time on the clock**. Take payment, start a timer on
that board's card. If they say they've paid and it still says time's up — **extend**.

### §7f — Forgot the PIN
On any PC: close WinchesterDarts, open `WinchesterDarts\data\settings.json` in
Notepad, set `"adminPin"` to `"1234"`, save, restart the exe. Then change it properly
from the staff console (which sets every board).

### §7g — A board shows "offline" on the staff console
That board's PC is off, asleep, or lost Wi-Fi. Its own screens will be down too. Wake
the PC, check the network cable/Wi-Fi, double-click the exe. The card comes back by
itself; the leaderboard refills within half a minute.

### §7h — Everything dead
Venue Wi-Fi or power. Router first, then each PC. Every hub restores its own state —
games, timers, history — when it comes back.

## 8. FAQ

**Do we need internet?** No — everything is local. Internet only matters for
installing or updating.

**Can customers play without paying?** No. Games only start while a timer is running —
staff open every session from the console.

**"It said BUST but I hit exactly zero."** With *Double to finish* on (the default)
the last dart must land in a double. That's darts, not a fault.

**A dart bounced out.** Fix tab → **Undo dart**, or tap it in on the board picture.

**Can they play without the smartboard?** Yes — tap darts in on the board picture.
Same games, same TV, same announcer.

**The board scored a dart nobody threw.** Undo it. Happening a lot = low batteries.

**Does the monthly leaderboard reset?** Automatically, each calendar month. All-time
records never reset.

**Can we change colours / name on screen?** Staff console → Venue settings — applies
to every board at once. A `logo.png` in `public\brand` (per PC) replaces the crest.

**Custom celebration GIFs / announcer voice?** Same as before, per PC: GIFs into
`celebrations` named `oneeighty.gif` etc.; mp3s into `public\sounds` with the same
names to replace the voice.

**How many players per game?** Up to 8. Names clear automatically when the session's
timer runs out.

**Does a PC restart lose anything?** No — game, scores, names, timer and history all
come back.

## 9. Tech corner

- **Per PC**: `WinchesterDarts.exe`, port 8080 (change in `settings.ini`), state in
  `data\` (JSON). No install, no admin rights. Autostart: shortcut in `shell:startup`.
  Firewall: allow on **private** networks. Fixed IPs strongly recommended.
- **Screens per hub**: `/tv`, `/pad`, `/board`, `/staff`; `/` lists all with QR codes;
  `/health`; `/api/board-diag(.txt)` for diagnostics.
- **Multi-board**: peer addresses stored in the main hub's settings (`peers`).
  `/staff` and `/board` served by any hub read every configured peer directly —
  there is no master server; each hub owns its own board, games and history.
  Read-only merge APIs: `/api/peers`, `/api/history` (CORS-open). Commands go over
  each hub's own socket and still require that hub's PIN.
- **History**: up to 5,000 games per hub, with per-game `board`, `oneEighties` and
  `bestVisit` for the record books.
- **The board**: Unicorn Smartboard, service `fff0`; `0x03` starts scoring (rim LED
  red→green); packets `[segment, multiplier]`; `55 AA` = rim button; battery via the
  standard service; "Line up board" computes the rotation from one dart.
- **Support (board hardware)**: Unicorn — **0115 985 3500**, Mon–Fri 9:00–17:00 ·
  assist@playwiththebest.com.

*Manual updated August 2026 — multi-board venues, staff console, merged
monthly/all-time leaderboard, staff-opened sessions, settings moved off the players'
iPad.*
