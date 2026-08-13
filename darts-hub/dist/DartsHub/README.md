# Darts Hub

Interactive darts scoring for a venue: your Windows PC is the brain, the 40"
TV is the show, an iPad runs the game. Talks to a Unicorn Smartboard over
Bluetooth; plays fine without one too (score by tapping the board on the iPad).

```
Unicorn Smartboard ──Bluetooth──▶  Windows PC  ──Wi-Fi──▶  TV   /tv
                                  (Darts Hub)   └────────▶  iPad /pad
```

## Install

1. Unzip `DartsHub-win64.zip` somewhere permanent, e.g. `C:\DartsHub`
   (**not** inside OneDrive — sync and live data files don't mix).
2. Double-click **`DartsHub.exe`**. A console window opens, the TV screen
   opens in your browser, and the console prints the addresses to use from
   other devices.
3. On the iPad, open `http://<pc-ip>:8080/pad` (the console shows the exact
   address). Add it to the Home Screen for a full-screen app feel.
4. On the TV, open `http://<pc-ip>:8080/tv` — or, if the TV is plugged into
   this PC's HDMI, the window that opened already is it (press F11 for
   full screen).

Nothing is installed system-wide. Deleting the folder removes everything;
your players and match history live in `data\`.

## The two screens

**TV (`/tv`)** — live dartboard that lights the exact bed each dart hits,
big scoreboard, the current visit, checkout routes ("you need T20 T20 D12"),
and celebrations: confetti and a fanfare for a 180, GAME SHOT! on a
checkout, a red screen-shake for a bust, plus 100+/140+ callouts.

**iPad (`/pad`)** — four tabs:

| Tab | What it does |
|-----|--------------|
| **Play** | Live scores, the current visit, *Next player*, *Undo dart*, *Miss*, and a tap-the-board keypad for bounce-outs or playing with no smartboard |
| **New game** | Pick the game and variant, set options, add/choose players, start |
| **Fix** | Undo darts, type a player's score directly, restart the game, end the game, recent results |
| **Settings** | Board ID and button number, connect/disconnect the board, celebration and sound toggles, the URLs for each screen |

## Games

- **X01** — 501/301/701, double-out (optional double-in), best-of-N legs,
  3-dart averages, 100+/140+/180 tracking, checkout suggestions.
- **Cricket** — standard or cut-throat; close 20→15 and the bull.
- **Around the Clock** — 1 to 20 then the bull; optional "doubles and
  trebles jump ahead".
- **Count-up** — most points over a set number of rounds. No busts, good
  for casual players.

## Connecting the smartboard

1. Bluetooth on in Windows, board awake (throw a dart), and **no phone
   connected to it** — the board accepts one connection at a time.
2. iPad → **Settings** → *Connect board*. Devices it sees appear in the list;
   tap the one named like a dartboard to lock it in, or leave the Board ID
   blank and the hub picks a device whose name looks like a dartboard.
3. Set **Button number** to the segment printed next to the board's rim
   button. If every score is wrong by the same rotation, this is why.
4. The board's rim button = end of turn / next player.

The header pill on the iPad shows the board state at a glance; the TV shows
it along the bottom.

## Your own celebration clips

Drop GIFs into the `celebrations` folder named `oneeighty.gif`,
`checkout.gif`, `matchwin.gif`, `legwin.gif`, `bust.gif`, `140.gif`,
`100.gif`, `closed.gif`. They play instead of the built-in animation.
Refresh the TV page after adding files.

## Notes for the venue

- **Firewall**: the first run may prompt to allow Node.js — allow it on
  **private** networks, or the iPad and TV can't reach the hub.
- **Same network**: iPad and TV must be on the same Wi-Fi as the PC. Guest
  networks with client isolation will not work.
- **Fixed address**: give the PC a DHCP reservation so the URLs you write
  down keep working.
- **Crash-safe**: the match is saved after every dart. If the PC restarts
  mid-game, start the hub again and the game is exactly where it was.
- **Auto-start**: Task Scheduler → new task → *When I log on* → start
  `DartsHub.exe`, "Start in" = its folder.

## Development

```bash
npm install
npm start          # then http://localhost:8080/tv and /pad
./build-hub.sh     # produces dist/DartsHub-win64.zip (needs mingw + zip)
```

`server/games.js` holds every rule; matches are stored as a dart log and
replayed, which is why undo and score corrections are always exact. Adding a
game means adding one strategy object there — `init`, `applyDart`, `view`.
