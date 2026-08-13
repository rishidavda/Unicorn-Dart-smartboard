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

## The two addresses

Every screen is just a web page served by this PC. Suppose the PC is
`192.168.1.50`:

| Screen | Address |
|--------|---------|
| **TV** | `http://192.168.1.50:8080/tv` |
| **iPad** | `http://192.168.1.50:8080/pad` |

Three ways to find them, whichever suits:

- The **console window** prints both when the hub starts.
- Open **`http://192.168.1.50:8080`** (no path) on any device — you get a
  chooser page with both addresses, big **QR codes** to scan, and copy
  buttons. The `1 - Screen addresses (open me)` shortcut in the folder opens
  it on the PC.
- The **TV's own welcome screen** shows both addresses and a QR code for the
  control panel; the iPad shows them under **Settings → Screen addresses**.

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

## House branding

The venue name, tagline and colours show on every screen and are edited from
the iPad under **Settings → Venue**:

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
- **Auto-start**: Task Scheduler → new task → *When I log on* → start
  `WinchesterDarts.exe`, "Start in" = its folder.

## Development

```bash
npm install
npm start          # then http://localhost:8080/tv and /pad
./build-hub.sh     # produces dist/WinchesterDarts-win64.zip (needs mingw + zip)
```

`server/games.js` holds every rule; matches are stored as a dart log and
replayed, which is why undo and score corrections are always exact. Adding a
game means adding one strategy object there — `init`, `applyDart`, `view`.
