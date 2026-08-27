# The Winchester · Darts

Interactive darts scoring for the venue: your Windows PC is the brain, the 40"
TV is the show, an iPad runs the game. Talks to a Unicorn Smartboard over
Bluetooth; plays fine without one too (score by tapping the board on the iPad).

```
Unicorn Smartboard ──Bluetooth──▶  Windows PC  ──Wi-Fi──▶  TV   /tv
                                  (Darts Hub)   └────────▶  iPad /pad
```

## Install

1. Unzip `WinchesterDarts-win64.zip` somewhere permanent, e.g. `C:\WinchesterDarts`
   (**not** inside OneDrive — sync and live data files don't mix).
2. Double-click **`WinchesterDarts.exe`**. A console window opens and prints the
   two addresses in plain text; the TV screen opens on this PC as well.

Nothing is installed system-wide. Deleting the folder removes everything;
your players and match history live in `data\`.

## The four addresses

Every screen is just a web page served by this PC. Suppose the PC is
`192.168.1.50`:

| Screen | Address |
|--------|---------|
| **TV** | `http://192.168.1.50:8080/tv` |
| **iPad** | `http://192.168.1.50:8080/pad` |
| **Leaderboard** | `http://192.168.1.50:8080/board` |
| **Staff console** | `http://192.168.1.50:8080/staff` |

Three ways to find them, whichever suits:

- The **console window** prints both when the hub starts.
- Open **`http://192.168.1.50:8080`** (no path) on any device — you get a
  chooser page with both addresses, big **QR codes** to scan, and copy
  buttons. The `1 - Screen addresses (open me)` shortcut in the folder opens
  it on the PC.
- The **TV's own welcome screen** shows both addresses and a QR code for the
  control panel; the staff console header links to every board's screens.

On the iPad, open the control panel and tap **Share → Add to Home Screen** so
it launches like an app. On the TV press **F11** for full screen.

## Works with no internet

The hub never calls out to the internet: Node.js, fonts, socket.io, the QR
codes and every celebration animation are all inside the folder and served
from this PC. A venue network with no internet at all — or the PC's own
hotspot — is fine. All the devices need is to be on the same network as the
PC (and DNS is not needed since the addresses are plain IPs).

## The two screens

**TV (`/tv`)** — live dartboard that lights the exact bed each dart hits,
big scoreboard, the current visit, checkout routes ("you need T20 T20 D12"),
and celebrations: confetti and a fanfare for a 180, GAME SHOT! on a
checkout, a red screen-shake for a bust, plus 100+/140+ callouts.

**iPad (`/pad`)** — four tabs:

| Tab | What it does |
|-----|--------------|
| **Play** | Live scores, the current visit, a **live hint telling the thrower exactly what they need** ("Hit treble 14", "141 to win: T20 T19 D12"), *Next player*, *Undo dart*, *Miss*, and a tap-the-board keypad for bounce-outs or playing with no smartboard |
| **New game** | Two steps: add/pick **players**, then **choose a game** from four groups (Classics · Party games · Score races · Practice). Every game card has a **How to play** button with the rules in plain English |
| **Prize** | The £1,000 challenge: the rules, how to take part (tell the bar, staff video it), and a live 21-dart counter during an attempt |
| **Fix** | Undo darts, type a player's score directly, restart the game, **Pick another game** (same players, back to the menu), end the game, recent results |

The players' iPad has **no settings tab** — everything staff-only lives on the
staff console, and **games only start while a timer is running** (staff open
every session).

## The other two screens

- **`/board` — the venue leaderboard.** Merged across every configured board:
  **top 50 by wins over the last 30 days** — a rolling window, so the table
  never empties on the 1st; games just drop off as they turn 30 days old,
  and staff can **restart the table** any time from the console (All time
  and the records keep everything) — plus the **all-time top 10**, record
  books (best visit, most 180s in a game, quickest X01 win), **highest
  scores** — 501's biggest visits and Around the Clock (triples) furthest
  runs — and latest results labelled by board. Read-only.
- **`/staff` — the staff console.** PIN-protected (tap or type the PIN —
  keyboard and mouse work everywhere), one card per board:
  start / **extend** / **end** customer timers — or a **stopwatch** for
  pay-at-the-end sessions (counts up, never expires, *End now* to settle) —
  board connect/wake/line-up,
  diagnostics, test the caller, and venue settings applied to every board at
  once. Locks itself 30 s after the screen is left. At zero the oche closes:
  game ends, player list clears, and the players' iPad shows "Time's up"
  until the next timer.

## The till

Every session gets a price from one venue setting (**Price per hour**,
default £10): timer sessions charge the minutes staff put on the clock,
extensions included; **stopwatch sessions charge time played — minimum one
hour, then to the nearest 30 minutes**. Ending a session shows its price,
each board's card shows the last bill, and the console's **Played today**
list shows every session — who played (the names they entered on the iPad),
how long, and what they owe — totalled for the day.

Paperwork does itself: at midnight each hub writes the finished day's PDF to
`reports\<Month>\DD-MM-YY-report.pdf` next to the exe (created if missing;
days the PC slept through are filled in at next start), and every card links
to a **today-so-far PDF** any time. The report leads with **MONEY TAKEN
TODAY** in big print, lists every session, and shows any cash prizes paid
out with the net figure.

## Several boards, one venue

One PC per oche (board + TV + players' iPad each), all on the venue Wi-Fi:

1. Run `WinchesterDarts.exe` on each PC; give the PCs fixed IPs.
2. Pick a **main PC**. On its `/staff` → *This venue's boards* → **Find
   boards**: every PC running WinchesterDarts on the network answers, and one
   tap adds it. Only boards using **this venue's PIN** can be added — a new
   PC (PIN still `1234`) shows up as "not using this venue's PIN" until you
   set it. (Typing an address like `http://192.168.1.51:8080` still works as
   the fallback.)
3. Names sort themselves out: every new PC arrives as "Board 1", and the
   console renames clashes to the next free **Board 2**, **Board 3**… by
   itself. Use **Rename** on a card for anything fancier ("Front oche").
   Bookmark the main PC's `/staff` on the till iPad and `/board` on the
   leaderboard screen.

One PIN unlocks every board (changing it from the console updates all).
Boards stay independent — each hub owns its own games and history; the staff
console and leaderboard read them all directly, so one PC being off never
stops the rest.

**Two boards on ONE PC** also works: unzip the zip into two folders
(`WinchesterDarts-Board1`, `WinchesterDarts-Board2`) and run both exes — the
second copy notices port 8080 is taken and **steps up to 8081 by itself**, so
there's nothing to edit. Its screens live at `http://<pc>:8081/tv` and
`/pad`. Even a folder **copied from a used one** sorts itself out: the first
Find boards scan spots the duplicate identity and the copy takes a fresh one
on the spot. With two smartboards in range the hub **won't blind-grab one**:
it lists both and asks you to tap the right board on the staff console
(which locks each hub to its board permanently). Two gotchas: **allow the
firewall prompt for BOTH copies** (Windows asks once per folder — a blocked
copy is invisible to Find boards), and both boards must be within Bluetooth
range of the one PC. One PC down means both oches down.

## The £1,000 challenge

The players' iPad has a **Prize** tab: Around the Clock, **triples only**,
treble 1 → treble 20 then the bull, **without a single miss** — 21 perfect
darts for the cash. Punters read the rules there; the attempt itself is
**staff-armed only**: they tell the bar, staff start the video, then start
the attempt from the board's card on the console (player's name → **Start
attempt**). The TV and pad show the perfect run live; one miss ends the
attempt (the game plays on for fun) with a "SO CLOSE" card, and a win gets
the full fanfare plus a staff alert to keep the video. Attempts — won or
busted — are logged and appear on the daily report; the prize amount is a
venue setting (default £1,000).

## Games — 24 of them

Grouped on the iPad exactly as below; each card's **How to play** button
shows the full rules.

**Classics**

- **X01** — 501/301/701/1001, double-out (optional double-in), best-of-N
  legs, 3-dart averages, 100+/140+/180 tracking, checkout suggestions.
- **Cricket** — standard or cut-throat; close 15→20 and the bull.
- **Around the Clock** — 1 to 20 then the bull; variants: fast (trebles
  jump ahead), **doubles only**, **triples only**.
- **Shanghai** — round N scores on N; single+double+treble in one visit
  wins on the spot.

**Party games**

- **Killer** — arm on your own double, then take lives on the others'.
- **Halve It** — miss the round's target with all three darts and your
  score halves.
- **Gotcha** — first to the target exactly; land on someone's score and
  they go back to nought.
- **Baseball** — nine innings, score on the inning's number.
- **Golf** — 18 holes, par on each number; lowest score wins.
- **Scram** — one blocks, one scores, then swap.
- **Chase the Dragon** — climb 10→20 then the bulls; trebles and doubles
  only.
- **Tennis** — points, games, sets; two players.
- **Legs** — beat the previous visit's score or lose a leg.
- **Sudden Death** — lowest visit each round is eliminated.
- **Prisoner** — singles get captured, doubles rescue them.
- **Nearest the Bull** — closest to the bull each round takes the point.

**Score races**

- **Count-Up** — most points over 8 rounds. No busts, good for casual
  players.
- **High Score** — first past the target total.
- **Around the Board** — score on every number 1→20, any order.

**Practice**

- **Bob's 27** — doubles round the clock from 27 points.
- **121 Checkout** — check out 121 in six darts; the target climbs.
- **5-Dart Double** — five darts at each double, round the board.
- **9-Dart Challenge** — nine darts at 501; chase the perfect leg.
- **170 Challenge** — T20 T20 Bull, the biggest checkout in darts.

## Connecting the smartboard

1. Bluetooth on in Windows, board awake (throw a dart), and **no phone
   connected to it** — the board accepts one connection at a time.
2. Staff console → that board's card → **Board & sound** → *Connect*.
   Devices it sees appear in the list; tap the one named like a dartboard to
   lock it in, or leave the Board ID blank and the hub picks a device whose
   name looks like a dartboard.
3. If every score is wrong by the same rotation: **Line up board** → one
   dart into the big 20. Fixed permanently.
4. The board's rim button = end of turn / next player.

The header pill on the iPad shows the board state at a glance; the TV shows
it along the bottom.

## House branding

The venue name, tagline and colours show on every screen and are edited from
the **staff console under Venue settings** (applies to every board at once):

- **Venue name / tagline** — defaults to *The Winchester* / *Darts*. Appears
  on the TV brand bar, the welcome screen, the celebration overlays, the
  control panel header, the chooser page and the browser tab titles.
- **House colours** — four themes: **Green & gold** (default), **Claret &
  gold**, **Black & gold**, and **Midnight neon**. Picking one restyles both
  screens instantly, confetti included.
- **Your own logo** — drop `logo.svg` (best) or `logo.png` into
  `public\brand` and it replaces the built-in crest everywhere. Square images
  work best; delete the file to go back to the crest.

## Your own celebration clips

Drop GIFs into the `celebrations` folder named `oneeighty.gif`,
`checkout.gif`, `matchwin.gif`, `legwin.gif`, `bust.gif`, `140.gif`,
`100.gif`, `closed.gif`. They play instead of the built-in animation.
Refresh the TV page after adding files.

## Notes for the venue

- **Firewall**: the first run may prompt to allow Node.js — allow it on
  **private** networks, or the iPad and TV can't reach the hub.
- **Wrong address?** If the PC has several network adapters (Wi-Fi plus
  Ethernet, or WSL/VirtualBox), the chooser page lists the alternatives at
  the bottom — try those before assuming something is broken.
- **Same network**: iPad and TV must be on the same Wi-Fi as the PC. Guest
  networks with client isolation will not work.
- **Fixed address**: give the PC a DHCP reservation so the URLs you write
  down keep working.
- **Crash-safe**: the match is saved after every dart. If the PC restarts
  mid-game, start the hub again and the game is exactly where it was.
- **Sleep-safe**: when the PC wakes from sleep the hub notices and rebuilds
  the Bluetooth connection itself — no more closing and reopening the app.
- **Auto-start**: Task Scheduler → new task → *When I log on* → start
  `WinchesterDarts.exe`, "Start in" = its folder.

## Development

```bash
npm install
npm start          # then http://localhost:8080/tv and /pad
./build-hub.sh     # produces dist/WinchesterDarts-win64.zip (needs mingw + zip)
```

`server/games.js` (core) and `server/games-extra.js` (the party/practice
library) hold every rule; matches are stored as a dart log and replayed,
which is why undo and score corrections are always exact. Adding a game
means adding one strategy object — `init`, `applyDart`, `view` — and it
appears on the iPad, TV and leaderboard automatically.
