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
3. Pick a **main PC**. On its `/staff` page → *This venue's boards* → **Find boards**.
   Every other PC running WinchesterDarts answers within a couple of seconds — tap one
   (or **Add all**) and the console links up by itself. Only boards that share **this
   venue's PIN** can be added: a brand-new PC (PIN still `1234`) is reported as "not
   using this venue's PIN" until you set its PIN to match — that's the system refusing
   to trust a machine that hasn't proved it's yours. Typing an address into the box
   still works if a board doesn't show up (see §7g).
4. Names sort themselves out: every new PC arrives calling itself "Board 1", and the
   console renames clashes to the next free **Board 2**, **Board 3**… automatically
   (a toast tells you when it happens). Use **Rename** on a card for anything fancier
   ("Front oche" — whatever staff say out loud). Every card carries that board's own
   controls: timer, **Line up board**, Connect/Wake, caller test and its diagnostics
   report.
5. Bookmark the **main PC's** `/staff` on the till iPad and `/board` wherever the
   leaderboard lives. Done — one PIN unlocks every board (set the same PIN everywhere;
   changing it from the staff console updates all boards at once).

Each board's own screens stay as before: its `/tv` on its TV, its `/pad` on its
players' iPad.

**Two boards on one PC?** Unzip the app into two folders and run both exes — the
second finds its own port automatically (its screen page shows the address), and
even a folder copied from a used one takes a fresh identity on the first Find
boards scan. **Say yes to the firewall prompt for BOTH copies** — Windows asks
once per folder, and a blocked copy is invisible to Find boards. With two
smartboards in range, each hub will ask you to **tap the right board** on its
card rather than guessing; do it once and it remembers. Keep both boards within
Bluetooth range of the PC. One more thing that LOOKS like a fault but isn't:
a board that's already connected to the other hub stops advertising, so the
device list showing just one board usually means the other is already taken —
exactly right.

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
2. On that board's card: **1 hour**, **2 hours**, custom → **Start** — or
   **Stopwatch (pay at end)** for open-ended time that counts UP instead of down.
3. The players' iPad unlocks instantly. The clock **starts when their first game
   starts** — not when you press the button — and shows on every screen (countdowns
   turn red in the last five minutes; the stopwatch just keeps counting until you
   press **End now** — the console then shows what to charge).
4. **At zero the oche closes itself**: the game ends, the player names clear, and the
   players' iPad shows *"Time's up — see the bar"* until the next timer. Nothing
   carries over between groups.
5. Mid-session: **+15/+30/custom** to sell more (extending an expired session reopens
   the oche), **End now** for the group that left early, **Clear** to remove the timer
   (clearing a session that already started also ends the game and clears the players).

Timers survive a PC restart — time sold is time owed.

## 4½. The till — what to charge

One venue setting does the pricing: **Price per hour** (venue settings, default £10,
applies to every board).

- **Timer sessions** charge the minutes you put on the clock, extensions included —
  1 hour = £10, 2 hours = £20, +30 min = +£5.
- **Stopwatch sessions** charge the time actually played: **minimum 1 hour, then to
  the nearest 30 minutes**. 74 minutes is an hour (£10); 76 minutes is an hour and a
  half (£15).

When a session ends — timer running out, **End now**, or **Clear** — the price pops
up, the board's card shows the **last session's bill**, and the console's **Played
today** list shows every session of the day: times, board, the **first names the
players entered on the iPad** (that's your "who's playing" list — everyone who
appeared during the session stays on its bill), minutes, price, and the day's total.

**The £-prize attempt.** The players' iPad's **Prize** tab explains the challenge
(Around the Clock, triples only, 21 darts, not one miss — default £1,000, changeable
in venue settings). Attempts only count when **you** start them: get the video
rolling FIRST, then on that board's card type the player's name → **Start attempt**.
The TV shows the perfect run live; a win sets off the full celebration and an alert
to keep the video safe. Won or busted, every attempt is listed on the daily report.

**The paperwork writes itself.** At midnight each board's PC saves the finished
day's PDF report under its own `reports` folder — e.g. `reports\Aug\27-08-26-report.pdf`
(the folders appear by themselves; if the PC was off at midnight the report is
written the next time it starts). The report leads with **MONEY TAKEN TODAY** in
big print, then every session, then any cash prizes paid out and the net. Every
card also links to a **today-so-far PDF** you can open, print or AirDrop straight
from the console.

## 5. The leaderboard (`/board`)

Merged across every board, live:

- **Last 30 days · top 50** by wins (played and win % shown). A **rolling** window —
  the table never empties on the 1st; games simply drop off as they turn 30 days old.
  Want a genuinely fresh slate (a new league, a season)? **Restart the top-50 table**
  from the console's venue settings — All time and the records keep everything.
- **Highest scores**: 501's biggest visits and Around the Clock (triples) furthest runs.
- **All time**: the top 10 by wins, plus the record books — **best visit**, **most 180s
  in one game**, **quickest X01 win**.
- **Latest results** labelled by board.

Read-only and safe anywhere — a spare telly or a customer's phone. If a board's PC is
off, the page says whose games are missing and picks them up when it returns.

## 6. Running games (the players' iPad)

Four tabs — **Play / New game / Prize / Fix** — and no settings to fiddle with. Starting a
game is **two easy steps**:

1. **Who's playing** — type names once (remembered until the session ends), tap to
   pick, long-press to delete. Then *Next: pick a game*.
2. **Pick a game** — games are grouped into **Classics, Party games, Score races and
   Practice**. Every card has a **How to play** button that explains the rules in
   plain English before anyone commits. Pick a variant, set options, **Start game**.
   Games that need an exact player count say so before they start.

During play: one screen — scores, a **live hint** telling the thrower what they need next
("Hit treble 14", "141 to win: T20 T19 D12" — shown on the TV too), dart slots,
**Next player / Undo dart / Miss**, and
a tap-the-board picture for bounce-outs or smartboard-free play. **The board's rim
button = next player.** Turn ends: the TV holds the three darts and total for ten
seconds and the announcer calls it. **Fix** has undo, direct score-setting, **Restart
game**, **Pick another game** (keeps the players) and **End game**.

### The games — 24 of them

**Classics** — *X01* (501 / 301 / 701 / 1001, double-out optional), *Cricket*
(+ Cut-throat), *Around the Clock* (any-hit / jump-ahead / doubles-only /
triples-only), *Around the Board* (the numbers in board order, 20 → 5, then bull).

**Party games** — *Killer*, *Shanghai*, *Halve It*, *Baseball* (9 innings, runs on
the inning's number), *Golf* (18 holes, lowest strokes), *Scram* (2 players:
stopper v scorer, then swap), *Gotcha* (land exactly on someone's score to send
them back to nought), *Chase the Dragon* (10→20 in order, then 25, then bull),
*Tennis* (2 players, real tennis scoring by visits), *Legs* (beat the last visit
or lose a leg), *Sudden Death* (lowest visit each round is out), *Prisoner*
(Around the Clock with lives), *Nearest the Bull* (bulls are points).

**Score races** — *Count-up* (highest after 8 rounds), *High Score* (first to
500/750/1000), *9-Dart Challenge* (nine darts, biggest total).

**Practice** — *Bob's 27* (the famous doubles drill), *121 Checkout* (six darts to
take out 121), *5-Dart Double Challenge*, *170 Challenge* (the big fish).

Every rule summary above is also on the iPad behind each game's **How to play**
button — staff never need to memorise them.

## 7. Troubleshooting

### §7a — Board connected but darts not counting

Open that board's card → **Board & sound**. The **Darts heard** counter is the truth:
throw a dart at the board and watch it. If it climbs, the board is fine — the problem
is elsewhere (no game running, no time on the clock). If it doesn't move:

1. **Red warning about the SAME dartboard?** Two cards are holding one board (usually
   a copied folder). On one card, tap that hub's **own** board in the device list.
2. Press **Fix board connection** — it tears the Bluetooth link down and rebuilds it
   from a fresh scan (~10 seconds), which is what closing and reopening the app used
   to do. Then throw again and watch the counter.
3. Still nothing → **batteries**. Three fresh AAs; a tired board keeps its light and
   button long after darts stop registering.
4. If the **PC was asleep**, give it half a minute first: the hub notices the wake-up
   and rebuilds the connection by itself (*"PC woke up — reconnecting to the board"*).
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
